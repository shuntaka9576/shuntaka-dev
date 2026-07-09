# DROP TABLE 後も TiKV のメモリ使用量が下がらない件の調査と解放手順

- 観測日: 2026-07-03
- 対象: 検証用 self-hosted TiDB クラスタ (`basic`, tidb-cluster namespace)
- 関連: [2026-07-01 LOAD DATA 大容量ファイル調査](../../97_survey/2026-07-01-tidb-load-data-large-file/index.md), [`cluster/manifests/tidb-cluster/tidb-cluster.yaml`](../../../../cluster/manifests/tidb-cluster/tidb-cluster.yaml)

## 症状

`tidb-seeder` で 500 万行 (約 33GB) を LOAD DATA した検証用テーブルを DROP したのに、TiKV 3 台のメモリ使用量が 8〜9 GiB のまま下がらない。

## 結論

**データ自体は GC・region マージまで完了して消えている。メモリの高止まりは TiKV (Rust) のブロックキャッシュと jemalloc の設計によるもので、リークではない。**

- RocksDB のブロックキャッシュは LRU で、`storage.block-cache.capacity`（本クラスタは 4GB）まで一度埋まると DROP TABLE ではパージされず、自発的に縮むこともない
- jemalloc は free 済みページをすぐ OS に返さない（retained ≈ 8GB を実測）
- cgroup のメモリ使用量にはページキャッシュ（inactive_file 1〜2.4GB）も含まれ、実態より大きく見える。この分はメモリ圧迫時にカーネルが自動回収する

limit 12Gi に対して 9GiB なので放置しても実害はない。リセットしたい場合は後述の rolling restart か block cache の動的縮小を行う。

## 調査手順

### 1. Pod 実メモリと anon / page cache の内訳

```bash
for p in basic-tikv-0 basic-tikv-1 basic-tikv-2; do
  echo "=== $p ==="
  kubectl exec -n tidb-cluster $p -- sh -c '
    cat /sys/fs/cgroup/memory.current
    grep -E "^(anon|file|inactive_file) " /sys/fs/cgroup/memory.stat'
done
```

実測 (2026-07-03):

| Pod          | memory.current | anon     | file (page cache) |
| ------------ | -------------- | -------- | ----------------- |
| basic-tikv-0 | 9214 MiB       | 6619 MiB | 2460 MiB          |
| basic-tikv-1 | 9060 MiB       | 6678 MiB | 2256 MiB          |
| basic-tikv-2 | 7947 MiB       | 6704 MiB | 1148 MiB          |

### 2. TiKV 内部のメモリ内訳 (status port :20180 の /metrics)

```bash
kubectl exec -n tidb-cluster basic-tikv-0 -- sh -c \
  'curl -s http://127.0.0.1:20180/metrics | grep -E "^tikv_engine_block_cache_size_bytes|^process_resident_memory_bytes|^tikv_allocator_stats"'
```

実測 (basic-tikv-0):

| 指標                                     | 値      | 意味                                          |
| ---------------------------------------- | ------- | --------------------------------------------- |
| process_resident_memory_bytes            | 7.28 GB | プロセス RSS                                  |
| tikv_engine_block_cache_size_bytes       | 4.28 GB | ブロックキャッシュ。設定上限 4GB に張り付き   |
| tikv_allocator_stats{type=allocated}     | 6.26 GB | jemalloc 経由で実際に使用中                   |
| tikv_allocator_stats{type=fragmentation} | 0.8 GB  | 断片化で OS に返っていない分                  |
| tikv_allocator_stats{type=retained}      | 8.03 GB | jemalloc が解放後も保持しているマップ済み領域 |

### 3. DROP したデータが実際に消えているかの確認 (PD)

```bash
kubectl exec -n tidb-cluster basic-pd-0 -- sh -c '
  /pd-ctl region --jq=".count"
  curl -s http://127.0.0.1:2379/pd/api/v1/stores | grep -E "region_count|region_size|leader_count"'
```

> `pd-ctl region` の出力は `{"count": N, "regions": [...]}` 形式。`--jq="length"` はトップレベルのキー数（常に 2）を返すので region 数には使えない。region 数は `.count`、リーダー偏りは stores 側の `leader_count` で見る（`region_count` はレプリカ数なので全 store で揃い、偏り判定には使えない）。

実測: region はクラスタ全体で 5 個 / 約 24MB。500 万行分の region は GC・マージ済みで存在しない。

> ディスク使用量 (`df -h /var/lib/tikv` で 39〜45GB) は local-path が OS ディスク共用のため、TiKV データではなく OS + コンテナイメージ等を含んだ値。

## 対処

### A. TiKV rolling restart（メモリを完全リセット）

3 レプリカ構成なので 1 台ずつなら安全。**必ず Ready を待ってから次に進む。**

```bash
for i in 0 1 2; do
  kubectl -n tidb-cluster delete pod basic-tikv-$i
  kubectl -n tidb-cluster wait --for=condition=Ready pod/basic-tikv-$i --timeout=10m
done
```

再起動後の確認:

```bash
for p in basic-tikv-0 basic-tikv-1 basic-tikv-2; do
  v=$(kubectl exec -n tidb-cluster $p -- cat /sys/fs/cgroup/memory.current)
  echo "$p: $((v/1024/1024)) MiB"
done
```

実測 (2026-07-03 再起動後): 3 台とも 8〜9 GiB → 3.7〜3.9 GiB に低下。

| Pod          | 再起動前 | 再起動後 |
| ------------ | -------- | -------- |
| basic-tikv-0 | 9214 MiB | 3917 MiB |
| basic-tikv-1 | 9060 MiB | 3733 MiB |
| basic-tikv-2 | 7947 MiB | 3911 MiB |

> ベンチを再開すればブロックキャッシュはまた上限 4GB まで積み上がる。恒久的に下げたいなら B を使う。

#### 再起動が数秒で完了した理由

今回の再起動はほぼ即時で Ready になったが、これは条件が特別に良かったため。TiKV の再起動時間はほぼ「持っているデータ（region 数と Raft ログ）の回復量」で決まる。

- GC 完了後の region はクラスタ全体で 5 個 / 約 24MB しかなく、RocksDB のオープンも Raft ステートの回復もほぼゼロ秒で終わる
- Pod 削除といっても local-path の PV は同じノードに残るので、データ移動や再レプリケーションは一切発生しない。PD がストアを down 扱いにしてレプリカ補充を始めるのはデフォルト 30 分後（`max-store-down-time`）なので、その前に戻ってくれば何も起きない
- ブロックキャッシュは永続化されないため「積み直し」は起動後に読み取りが来たとき遅延的に行われるだけで、起動時間には影響しない

500 万行 / 33GB が入ったままなら、数千 region の Raft 回復とリーダーの退避・再配置が入るので Ready まで今回よりはっきり時間がかかる（それでも数十秒〜数分オーダー）。「TiKV は常にこんなに速い」ではなく「ほぼ空のストアの再起動はただのプロセス再起動と同じ」という理解が正しい。

### B. ブロックキャッシュ容量の動的縮小（再起動不要・即時解放）

数少ない「実行するとメモリが実際に解放される」操作。TiDB に mysql 接続して実行する。

```sql
SET CONFIG tikv `storage.block-cache.capacity` = '2GB';
```

恒久化する場合は `cluster/manifests/tidb-cluster/tidb-cluster.yaml` の `[storage.block-cache] capacity` も合わせて変更して apply する（動的変更はプロセス再起動で失われる）。
