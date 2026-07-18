# PLaMo Embedding の投入後メモリ滞留 (glibc malloc) を jemalloc で解消

- 観測日: 2026-07-18
- 対象: plamo-embedding namespace の PLaMo Embedding Pod (node2 / node3)
- 関連: [`cluster/manifests/plamo-embedding/Dockerfile`](../../../../cluster/manifests/plamo-embedding/Dockerfile), [2026-07-15 TiDB Vector 検索実装](../2026-07-15-tidb-vector-search-implementation/index.md), PR #684 (メモリ上限 8Gi 引き上げ)

## 症状

embedding backfill の投入が終わっても、node2 / node3 のノードメモリが 38〜40% のまま投入前の 31〜32% へ戻らない。正体は PLaMo Pod で、投入完了から約 7 時間後のアイドル状態でも投入前より 1〜1.8GiB 増えたままだった。

| PLaMo Pod | 投入前アイドル | 投入中ピーク (memory.peak) | 投入後アイドル |
| --------- | -------------- | -------------------------- | -------------- |
| node2 側  | 5.72GiB        | 7.31GiB                    | 6.81GiB        |
| node3 側  | 5.45GiB        | 7.81GiB                    | 7.21GiB        |

増加分は cgroup の内訳を見るとほぼ全量が anon (ヒープ)。ノード全体の増加分 (2〜2.5GB) のうち Pod で説明できない残りは、書き込みを受けた TiKV 側のキャッシュ類とみられる。

## 原因

リークではなく glibc malloc の設計によるもの。同時リクエストの推論用に確保したアクティベーションの free 済みヒープを、glibc が OS へ返さず保持し続ける。この構成で起きやすい理由は 2 つ。

- server.py のエンドポイントは同期 `def` のため uvicorn がスレッドプールで捌き、複数スレッドからの malloc で glibc の arena が分散して trim されにくくなる
- glibc は「mmap で確保 → free」された大きなブロックを見ると mmap 閾値を動的に引き上げる (最大 32MiB) ため、数 MiB〜数十 MiB のアクティベーション確保が途中からヒープ側に載り、free しても OS へ返らなくなる

確保済み領域は次の推論で再利用されるため実害は「使用量がピークに張り付いて見える」ことだけだが、監視でノードメモリの異常と見分けづらくなるため対処した。

## 対処

アロケータを jemalloc に差し替えた (`cluster/manifests/plamo-embedding/Dockerfile`)。

```dockerfile
# apt に追加
libjemalloc2

# 実行時環境変数
ENV LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libjemalloc.so.2
ENV MALLOC_CONF=background_thread:true,dirty_decay_ms:10000
```

- `background_thread:true` が肝で、glibc と違いアプリがアイドルでもバックグラウンドスレッドが free 済み dirty page を約 10 秒の decay で OS へ返却する
- jemalloc は 8MiB 以上の確保を専用 arena で扱い free 時に即返すため、推論アクティベーションのような大きなブロックが滞留しない
- `.so` のパスは amd64 固定ビルド前提 (build-and-push.sh 参照)

### 検討した代替案

| 案                                                         | 見送り理由                                                                       |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------- |
| glibc の env 調整 (`MALLOC_ARENA_MAX=2` + mmap 閾値の固定) | image 変更不要で最軽量だが、返却はアロケータ任せで挙動の確実性が jemalloc に劣る |
| server.py で `malloc_trim(0)` を定期実行                   | 確実に効くがアプリコードにアロケータ都合の処理が混ざる                           |

image 再ビルドのコストが低いため、一番挙動がきれいな jemalloc 差し替えを採用した。

## 反映手順

```bash
./cluster/manifests/plamo-embedding/build-and-push.sh
kubectl -n plamo-embedding rollout restart deployment/plamo-embedding
kubectl -n plamo-embedding rollout status deployment/plamo-embedding --timeout=10m

# jemalloc がロードされているか確認 (必ず rollout 完了後に実行)
kubectl -n plamo-embedding exec deploy/plamo-embedding -- grep -m1 jemalloc /proc/1/maps
```

> ロールアウト中に `exec deploy/...` を実行すると旧 image の Pod に入ることがあり、grep が exit 1 になる。maxSurge=0 のローリング更新は image pull (数 GB) を挟んで Pod 1 台ずつ数分かかるため、必ず `rollout status` の完了を待ってから確認する。
>
> 実測 (2026-07-18 反映直後): 両 Pod とも `/proc/1/maps` に libjemalloc.so.2 を確認。memory.current は node2 / node3 とも約 4.3GiB (モデルロード直後のベースライン)。

効果確認は、次回 backfill 完了から 1 分ほど置いて Pod の RSS (または cgroup の anon) が投入前水準へ戻ることを見る。

```bash
kubectl -n plamo-embedding exec <pod> -- sh -c '
  cat /sys/fs/cgroup/memory.current
  grep -E "^anon " /sys/fs/cgroup/memory.stat'
```

## 注意

- jemalloc に替えても **memory.peak は下がらない**。ピークは同時 4 リクエスト分のアクティベーションが実際に必要としたメモリで、node3 側の実測 7.81GiB は上限 8Gi (PR #684 で引き上げ) まで 200MiB 弱しか余裕がない。並列度を上げる余地の判断はアイドル時の実測ではなく memory.peak で行う
- メモリを OS へ返すぶん、アイドル後の初回バーストはページ再確保でわずかに遅くなる (この QPS では誤差レベル)
