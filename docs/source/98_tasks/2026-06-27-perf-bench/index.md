# TiDB クラスタ性能ベンチ (2026-06-27)

3 ノード GMKtec M5 Ultra クラスタの TiDB v8.1.0 にどれくらい捌ける性能があるかを、point-select / OLTP read-write の 2 種類で計測したログ。

クラスタ構成は `2026-06-25_construction_plan.md` の通り。本ドキュメントは「実機で何を測ったか」「どこで詰まったか」「Aurora 換算」を残す。

## TL;DR

| ワークロード           | 数字                                      | Aurora MySQL 換算          |
| ---------------------- | ----------------------------------------- | -------------------------- |
| point-select read-only | **49k QPS, p95 4.3 ms** (threads=128)     | db.r6g.2xlarge writer 相当 |
| OLTP read-write mix    | **1,140 TPS / 22.8k QPS, p95 100–300 ms** | db.r6g.2xlarge writer 相当 |
| bulk INSERT…SELECT     | **約 416k rows/sec** (100 万行 / 2.4 秒)  | —                          |

ハードウェアは余裕があるが (バックグラウンド CPU 12%)、49k QPS は計測セットアップ上の上限。真の上限を測るにはクラスタ外の bench 専用機が必要。

## 物理前提

| 項目         | 値                                           |
| ------------ | -------------------------------------------- |
| ノード       | GMKtec M5 Ultra ×3 (`node1`/`node2`/`node3`) |
| CPU          | Ryzen 7 7730U 8C/16T @ 4.5GHz                |
| RAM          | 32 GB DDR4                                   |
| SSD          | 1 TB NVMe                                    |
| ネットワーク | TP-Link SG3210X-M2 2.5GbE switch             |
| OS           | Ubuntu Server 24.04 LTS                      |
| Kubernetes   | v1.31.14 (kubeadm + Cilium)                  |
| TiDB         | v8.1.0 (TiDB Operator v1.6.0)                |

ベンチ実行時 (2026-06-27 朝) の TiDB クラスタ初期配置:

```
PD     node2:1   node3:2   node1:0
TiKV   node2:2   node3:1   node1:0   ← 偏り
TiDB   node2:1   node3:1   node1:0
```

node1 に control-plane taint が残っていたため Pod が node2/3 にしか乗らず、TiKV-0/-1 が両方 node2 になっていた。

## 計測スクリプト

すべて `scripts/tidb/` 配下。

| ファイル           | 用途                                                           |
| ------------------ | -------------------------------------------------------------- |
| `tidb_load.sh`     | `bench.load_test` に 100 万行投入 + 簡易 heavy query           |
| `tidb_qps.sh`      | `mysqlslap` で point-select / UPDATE の並列スイープ            |
| `tidb_qps_push.sh` | 高並列 (256/512) で 10k QPS 突破を狙うスイープ                 |
| `sysbench_run.sh`  | sysbench oltp_point_select                                     |
| `sysbench_rw.sh`   | sysbench oltp_read_write / write_only / update_index           |
| `pybench.py`       | pymysql ベースの軽量 QPS 計測 (Mac から Tailscale LB に撃つ用) |

env で `TIDB_HOST` `TIDB_PORT` `TIDB_USER` `TIDB_DB` `THREADS_LIST` `TIME` を上書き可能。

## 実行環境のバリエーション

| ロケーション                    | 接続先                       |    1M 行 INSERT…SELECT 所要 |
| ------------------------------- | ---------------------------- | --------------------------: |
| Mac → kubectl port-forward 経由 | `127.0.0.1:4000`             |                       28 秒 |
| Mac → Tailscale LB              | `tidb.<tailnet>.ts.net:4000` | (pybench で 10k QPS 頭打ち) |
| **node1 → NodePort 直**         | **`127.0.0.1:31299`**        |                  **2.4 秒** |

node1 から NodePort 経由が 10 倍以上速い。port-forward は Mac↔Pi の TCP proxy が直列に乗るので latency に支配される。以後の bench は基本 node1 から実行。

## point-select QPS スイープ (sysbench oltp_point_select)

```bash
TIDB_PORT=31299 TIME=15 THREADS_LIST="64 128 256" \
  bash scripts/tidb/sysbench_run.sh
```

| threads |        QPS | p95 latency |
| ------: | ---------: | ----------: |
|      64 |     39,562 |     3.89 ms |
| **128** | **49,193** | **4.33 ms** |
|     256 |     44,952 |    10.65 ms |

threads=256 で QPS が下がって latency が 2 倍超になっているので頭打ち。

### この時のノード負荷

ベンチ中 (threads=128) の各ノード load average / sysbench プロセス:

| ノード | role                      | load avg (1m) | コメント                 |
| ------ | ------------------------- | ------------: | ------------------------ |
| node1  | sysbench クライアントのみ |     0.98 / 16 | sysbench 自体 1.55 cores |
| node2  | TiDB-0 + TiKV-0 + TiKV-1  |     4.06 / 16 | TiKV 2 個共存で偏ってる  |
| node3  | TiDB-1 + TiKV-2 + PD      |     1.64 / 16 |                          |

**3 ノード合計 48 cores のうち実質 5–6 cores (12%) しか使っていない**。ハードに余力ありで、49k はソフト側 (TiDB / TiKV のスケジューリング / kube-proxy 経路) の壁。

## OLTP read-write mix (sysbench oltp_read_write)

```bash
TIDB_PORT=31299 TIME=20 THREADS_LIST="32 64 128 256" \
  bash scripts/tidb/sysbench_rw.sh
```

| threads |     TPS |        QPS |    p95 |
| ------: | ------: | ---------: | -----: |
|      32 |     651 |     13,020 |  64 ms |
|  **64** | **864** | **17,286** |  94 ms |
|     128 |   1,010 |     20,203 | 167 ms |
|     256 |   1,140 |     22,801 | 314 ms |

各 transaction = 20 queries (10 SELECT + 4 UPDATE + 4 INSERT + 2 DELETE)。

実用上の良いポイントは threads=64 の 864 TPS / 17k QPS / p95 94ms。それ以上は latency 悪化が激しい。

## 49k QPS の壁を破ろうとした試み

ハード余力ありでソフト側上限らしいので、SQL 層と KV 層をそれぞれ scale-out して測った。

### 試み 1: control-plane taint 除去 + TiDB を 2→3 replicas

```bash
kubectl taint nodes node1 node-role.kubernetes.io/control-plane:NoSchedule-
kubectl -n tidb-cluster patch tc basic --type=merge -p '{
  "spec":{"tidb":{"replicas":3,
    "topologySpreadConstraints":[
      {"topologyKey":"kubernetes.io/hostname","maxSkew":1}
    ]}}}'
```

TiDB-2 が node1 に着地 → 3 ノード均等配置完了。再ベンチ:

| threads | QPS (TiDB=2) | QPS (TiDB=3) |
| ------: | -----------: | -----------: |
|     128 |       49,193 |       41,012 |
|     256 |       44,952 |       41,961 |
|     384 |            — |       42,845 |

**伸びるどころか下がった**。SQL 層は壁ではなかった。

### 試み 2: TiKV を 3→4 replicas + topology spread

```bash
kubectl -n tidb-cluster patch tc basic --type=merge -p '{
  "spec":{"tikv":{"replicas":4,
    "topologySpreadConstraints":[
      {"topologyKey":"kubernetes.io/hostname","maxSkew":1}
    ]}}}'
```

TiKV-3 が node1 に新規追加。PD のリージョン balance を待ってから再ベンチ:

| threads | QPS (TiKV=3) | QPS (TiKV=4 settled) |
| ------: | -----------: | -------------------: |
|      64 |       39,562 |               25,665 |
|     128 |       49,193 |               30,940 |
|     256 |       44,952 |               34,665 |

**さらに下がった**。

### なぜ TiKV を増やすと下がったか

決定的なのは **node1 が「bench 専用」から「bench + TiKV」になった**こと。

- TiKV=3 のとき: node1 は何も乗ってない → sysbench が CPU/IO を独占
- TiKV=4 のとき: TiKV-3 が node1 に乗った → sysbench と TiKV が CPU/IO を奪い合い

クラスタ自体の理論上限は TiKV=4 の方が高いはずだが、**計測クライアントが DB と同居した瞬間に「公正な計測」が不可能になる**。これが local-cluster の根本的な計測難。

## PD の状態の見方 (pd-ctl)

ベンチ中の region 分布や leader 分布を確認するときに使ったコマンド。

```bash
# エイリアス
alias pdctl='kubectl -n tidb-cluster exec -it basic-pd-0 -- /pd-ctl -u http://basic-pd:2379'

pdctl store              # store 一覧 (region_count, region_size, leader_count, leader_size)
pdctl operator show      # 進行中のリージョン移動 (空 = balance 完了)
pdctl scheduler show     # 動いてる scheduler 一覧
pdctl config show        # PD 設定 (max-replicas, schedule-limit 等)
pdctl store limit        # store ごとの ops/sec 上限
```

### `region_count` だけ見るとミスリードする話

TiKV-3 追加後、`region_count` だけ見ると激しく偏って見える:

| Store              | region_count | region_size | leader_count | leader_size |
| ------------------ | -----------: | ----------: | -----------: | ----------: |
| TiKV-0 (node2)     |          130 |      771 MB |           29 |          86 |
| TiKV-1 (node2)     |          121 |      779 MB |           37 |         141 |
| TiKV-2 (node3)     |          110 |      795 MB |           30 |         122 |
| **TiKV-3 (node1)** |           41 |  **769 MB** |           38 |     **689** |

`region_count` は **41 vs 130** で偏ってるように見えるが、`region_size` は全部 770–795 MB でほぼ均等。**count の差は「空 region と肥大 region の混在」によるもの**で、実データは均衡している。

代わりに **`leader_size` が TiKV-3 だけ 689 と突出**している。これは新規追加した sbtest テーブル (大きいリージョン少数) のリーダーが TiKV-3 に偏ったため。ベンチ対象は sbtest なので、リクエストの大半が node1 に集中 → node1 の CPU/IO が sysbench と取り合い → QPS 低下。

つまり「balance してない」のではなく「balance はしてるが leader 偏在が起きてる」。

ブラウザで見るなら **Grafana の `PD → Statistics - balance`** か **TiDB Dashboard の Store Topology** が早い。

## Aurora MySQL 換算

公開ベンチ (sysbench OLTP cached) との対比:

| Aurora インスタンス                | 想定 point-select QPS | 本クラスタ比                                              |
| ---------------------------------- | --------------------: | --------------------------------------------------------- |
| db.r6g.large (2 vCPU / 16GB)       |                 5–10k | 圧倒的に上                                                |
| db.r6g.xlarge (4 vCPU / 32GB)      |                15–25k | 上                                                        |
| **db.r6g.2xlarge (8 vCPU / 64GB)** |            **40–60k** | **ほぼ同等**                                              |
| db.r6g.4xlarge (16 vCPU / 128GB)   |               80–120k | TiDB pod を増やしてかつ別マシンから測ればここまで届きそう |

OLTP read-write の方:

| Aurora インスタンス |        想定 TPS | 本クラスタ比 |
| ------------------- | --------------: | ------------ |
| db.r6g.large        |         200–300 | 上           |
| db.r6g.xlarge       |         500–800 | 上           |
| **db.r6g.2xlarge**  | **1,000–1,500** | **ほぼ同等** |
| db.r6g.4xlarge      |     2,000–3,000 | 届かず       |

**結論: read-only / OLTP どちらでも db.r6g.2xlarge writer 1 台相当**。回収期間は比較対象の置き方で変わる。

- **性能等価比較**: Aurora db.r6g.2xlarge は月 $700–800 (≒ ¥11–12 万、$1=¥150)。本クラスタ (GMKtec M5 Ultra ×3 ≒ 30 万円) は**約 3 ヶ月**で回収。東京リージョン価格 ($1.25/hr ≒ ¥14 万/月) や別途のストレージ・I/O 課金を入れると更に短い
- **実需要比較**: このブログの実ワークロードに必要なのは db.r6g.large / Aurora Serverless v2 低 ACU クラス (月 $200 前後 ≒ ¥3 万) で、その比較なら回収は**1 年前後**

ただし Aurora は HA・自動バックアップ・ストレージ自動拡張全部込みで、手元クラスタはそれ (と電気代・故障リスク) を自分で面倒見る前提。

## やってないこと / 次の宿題

- **クラスタ外の bench 専用機からの計測**。今回は (Mac via Tailscale = 10k 頭打ち) と (node1 colocated = 49k) しか取れていない。同 LAN にもう 1 台 (別 Mini PC or Pi) 置いて測ると、真の上限が見える可能性。
- **TiKV / PD の rebalance を PV pin の壁を越えて実行する手順**。今回は新規 TiKV を追加するだけで終わったが、本来の rebalance は scale-out → store evict → scale-in の 3 段階を踏む。
- **TiKV scale-out 時の `store limit` チューニング**。デフォルト 15 ops/sec は遅すぎる気がする。
- **PD config (`region-schedule-limit`, `leader-schedule-limit`) の調整**で leader 偏りをどこまで早く解消できるか。
- **Mac の Homebrew sysbench が TLS/SSL を強制してくる問題の回避**。Docker 経由 or pingcap/go-tpc に切り替えるのが楽そう。

## 適用したクラスタ設定変更 (本検証由来)

`2026-06-25_construction_plan.md` 側に反映済みの変更:

1. **Phase 3 node1 手順に control-plane taint 除去ステップを追加**。これがないと TiKV/TiDB が node1 に乗らず必ず偏る。
2. **TidbCluster CR で全コンポーネントに `topologySpreadConstraints` を追加**。TiDB Operator v1.6 では `whenUnsatisfiable` フィールドは受け付けず、`maxSkew` + `topologyKey` のみ指定する (省略すると `DoNotSchedule` 扱い)。
3. **TiDB を 2 → 3 replicas に変更** (各ノード 1 個)。
4. **PD / TiKV は replicas=3 のまま topology spread を入れただけだと既存 PV ノード固定で動けない**点を注意書きに追加。新規構築なら最初から spread 入れて初期スケジュールで均等配置するのが正解、既存環境からの移行はちょっと面倒。

## ベンチ結果ファイル

node1 上の `/tmp/` 配下に残してある (再現したくなったら参照):

```
/tmp/sb_peak.out      ← TiKV=3 時の sysbench point-select (49k)
/tmp/sb_rw.out        ← OLTP read-write (1,140 TPS)
/tmp/sb_after.out     ← TiDB=3 時の point-select (41k に下がった)
/tmp/sb_tikv4.out     ← TiKV=4 直後の point-select (rebalance 途中)
/tmp/sb_settled.out   ← TiKV=4 settled 後の point-select (依然下がってる)
```
