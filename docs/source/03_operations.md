# 運用

blog-api (Lambda) 〜 tidb-proxy (forwarder) 〜 TiDB 経路で「遅い・おかしい」が起きたときに、原因箇所を最短で切り分けるための手順と、MiniPC クラスタの定常メンテナンス手順。設計・デプロイ手順は [OTel ボトルネック観測基盤](tasks/2026-07-03-otel-bottleneck-observability.md) を参照。

## 症状別インデックス

| 症状                           | 見る節                 |
| ------------------------------ | ---------------------- |
| API / ブログが遅い             | ボトルネック切り分け   |
| グラフの意味を知りたい         | ダッシュボード         |
| ダッシュボードにデータが出ない | テレメトリが出ないとき |
| 誰が何を送っているか知りたい   | テレメトリ一覧         |
| クエリの書き方を調べたい       | クエリリファレンス     |
| 検索がヒットしない・表示が変   | ハマりどころ           |
| MiniPC を再起動したい          | ノード再起動           |

## ボトルネック切り分け

| #   | 手順                                                  | 使うもの                                                   |
| --- | ----------------------------------------------------- | ---------------------------------------------------------- |
| 1   | p95 が悪化している時間帯を特定する                    | ダッシュボード `d-st-observability` / `p-st-observability` |
| 2   | SELECT 1（経路コストのみ）と実クエリの p95 を比較する | ダッシュボード                                             |
| 3   | TiDB 側の実行時間を同一時間窓で並べる                 | TiDB Dashboard / Statement Summary / Slow Query            |
| 4   | 判定表で原因を絞る                                    | 下表                                                       |
| 5   | 該当リクエストを個別に深掘りする                      | X-Ray（クエリリファレンス参照）                            |

判定表:

| 観測結果                                                | ボトルネック                                    |
| ------------------------------------------------------- | ----------------------------------------------- |
| SELECT 1 も実クエリも遅い                               | Tailscale / ネットワーク / forwarder / 接続経路 |
| SELECT 1 は速く実クエリだけ遅い                         | SQL / インデックス / TiDB / TiKV / 結果サイズ   |
| クライアント計測は高いが TiDB statement duration は低い | ネットワーク / forwarder / 結果転送             |
| `db.connection.duration` だけ高い                       | 接続確立 / pool / TLS / Tailscale 経路          |
| forwarder の `proxy.upstream.connect.duration` が高い   | forwarder → TiDB 経路                           |

参考実測値（2026-07-03）: Tailscale 経由の AWS Tokyo ⇄ 自宅 RTT ≈ 8ms。`SELECT 1` は ~18ms ≈ 2 往復（sqlx の `test_before_acquire` による取得前 ping の 1 往復を含む）。

## ダッシュボード

CloudWatch Dashboards の `d-st-observability`（dev）/ `p-st-observability`（prd）。定義は `iac/aws/lib/api/observability-construct.ts`。レイテンシ系はすべて p50 / p95 / p99、rate window は 15 分。

| ウィジェット                       | メトリクス（計測元）                                                      | 見方                                                                                                                                                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lambda request latency             | `app.request.duration`（blog-api）                                        | ハンドラ全体のエンドツーエンド。全ルートのリクエストが対象で、5 分毎の `/health/db` プローブや bot のアクセスも含まれる。そのためアクセスが無い時間帯もプローブだけで線が出続ける。実 API だけ見たいときはクエリを `"app.route"!="/health/db"` で絞り込む |
| DB client latency                  | `db.query.duration`（blog-api）                                           | Lambda から見た実クエリのレイテンシ。SELECT 1 は含まれない（`observe_query` が `query_type=select_1` のときだけ `db.healthcheck.duration` 側に記録するため）                                                                                              |
| DB baseline latency (SELECT 1)     | `db.healthcheck.duration`（blog-api）                                     | クエリ実行以外の経路コスト全部。Tailscale の片道遅延そのものではなく「RTT × 往復回数 + forwarder 中継」（`test_before_acquire` の ping 込みで ~2 往復）。実クエリとの差分が SQL 実行 + 結果転送。欠損が多い（ハマりどころ参照）                           |
| DB connection latency              | `db.connection.duration`（blog-api）                                      | pool の新規接続確立。ここだけ高ければ pool / TLS / Tailscale 経路                                                                                                                                                                                         |
| Forwarder upstream connect latency | `proxy.upstream.connect.duration`（tidb-proxy）                           | forwarder → TiDB の接続確立                                                                                                                                                                                                                               |
| Forwarder connections              | `proxy.connection.active` / `proxy.connection.accept.count`（tidb-proxy） | アクティブ接続数と accept 数（15 分増分）。accept の急増は再接続の嵐を疑う                                                                                                                                                                                |
| Forwarder errors                   | `proxy.error.count` / `proxy.timeout.count`（tidb-proxy）                 | 中継エラーとタイムアウト（15 分増分）。平常時はゼロ。loopback からの ECS ヘルスチェック接続は計測対象外（ハマりどころ参照）                                                                                                                               |
| Lambda cold starts / DB errors     | `lambda.cold_start.count` / `db.query.error.count`（blog-api）            | cold start 回数とクエリエラー数（15 分増分）                                                                                                                                                                                                              |

## テレメトリ一覧

送信元は blog-api（Lambda / Rust）と tidb-proxy（forwarder / Go）の 2 つ。どちらも OTLP で ADOT collector（tidb-proxy タスクの sidecar）に送り、collector が traces → X-Ray、metrics → CloudWatch Metrics に振り分ける。

### blog-api（Lambda / Rust）

計装の実体は `apps/blog-api/{api,adapter}/src/observability.rs`。

| テレメトリ                             | シグナル | 型        | 利用先（ダッシュボードのウィジェット等）  |
| -------------------------------------- | -------- | --------- | ----------------------------------------- |
| `app.request.duration`                 | metrics  | Histogram | Lambda request latency                    |
| `db.query.duration`                    | metrics  | Histogram | DB client latency                         |
| `db.healthcheck.duration`              | metrics  | Histogram | DB baseline latency (SELECT 1)            |
| `db.connection.duration`               | metrics  | Histogram | DB connection latency                     |
| `lambda.cold_start.count`              | metrics  | Counter   | Lambda cold starts / DB errors            |
| `db.query.error.count`                 | metrics  | Counter   | Lambda cold starts / DB errors            |
| segment `lambda.handler` + subsegments | traces   | Span      | X-Ray（トレース検索・ウォーターフォール） |

### tidb-proxy（forwarder / Go）

計装の実体は `apps/tidb-proxy/cmd/forwarder/otel.go`。

| テレメトリ                           | シグナル | 型               | 利用先（ダッシュボードのウィジェット等）    |
| ------------------------------------ | -------- | ---------------- | ------------------------------------------- |
| `proxy.upstream.connect.duration`    | metrics  | Histogram        | Forwarder upstream connect latency          |
| `proxy.connection.active`            | metrics  | Observable Gauge | Forwarder connections                       |
| `proxy.connection.accept.count`      | metrics  | Counter          | Forwarder connections                       |
| `proxy.error.count`                  | metrics  | Counter          | Forwarder errors                            |
| `proxy.timeout.count`                | metrics  | Counter          | Forwarder errors                            |
| `proxy.connection.duration`          | metrics  | Histogram        | （ダッシュボード未使用。PromQL で直接参照） |
| `proxy.bytes.in` / `proxy.bytes.out` | metrics  | Counter          | （ダッシュボード未使用。PromQL で直接参照） |
| segment `proxy.forward`              | traces   | Span             | X-Ray（トレース検索・ウォーターフォール）   |

## テレメトリが出ないとき

| #   | 確認                      | 方法                                                                                                                  |
| --- | ------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 1   | 既知の欠損でないか        | 「SELECT 1 ベースライン」はプローブ由来で大部分欠損する仕様（ハマりどころ参照）。リクエスト由来のメトリクスで判断する |
| 2   | collector が生きているか  | ECS タスクの `otel-collector` コンテナが HEALTHY か                                                                   |
| 3   | export が失敗していないか | `aws logs tail /ecs/tidb-proxy --since 15m` で `otel-collector` prefix に 4xx が無いか                                |

## 定常運用

| やること             | 方法                                                                                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| collector 疎通確認   | `aws logs tail /ecs/tidb-proxy --since 15m` で `otel-collector` prefix にエラーが無いこと                                                             |
| 再デプロイ           | Deploy workflow の workflow_dispatch（`stack` = `all` / `st-tidb-proxy` / `main`）。forwarder / collector 設定の変更は `scripts/deploy-tidb-proxy.sh` |
| 止める（コスト削減） | task def から `otel-collector` コンテナを外す（月 ~$1 が止まる）。アプリ側計装は `OTEL_EXPORTER_OTLP_ENDPOINT` 未設定なら no-op なので残してよい      |

## ノード再起動

MiniPC（node1〜3）を OS 再起動するときの手順。ノード配置の前提は [構築計画](tasks/2026-06-25-construction-plan.md) の「ノード別配置の想定」を参照。

### 前提と原則

| 項目             | 内容                                                                                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| control plane    | node1 のみ（apiserver / etcd / controller-manager / scheduler）。etcd は単一で、データは node1 のディスクにのみ存在する                                    |
| PD / TiKV / TiDB | 各ノードに 1 つずつ（3 レプリカ）。1 台落ちても raft quorum（2/3）が保たれるので DB は継続する                                                             |
| 原則 1           | **必ず 1 台ずつ**再起動する。2 台同時に落とすと PD / TiKV の quorum が崩れて DB 全体が止まる。前のノードが復帰して Pod が Running に戻ってから次へ進む     |
| 原則 2           | TiKV の `max-store-down-time`（デフォルト 30 分）以内に復帰させる（3 ノード 3 レプリカだとレプリカの移動先が無いため超過しても実害は小さいが、原則として） |
| 原則 3           | node1 停止中は kubectl / Pod 再スケジュール / Service エンドポイント更新がすべて止まる。node2/3 で動いている既存 Pod はそのまま動き続ける                  |

再起動後の自動復旧は構築時の永続化設定で担保されている。swap は `/etc/fstab` でコメントアウト済み、カーネルモジュールは `/etc/modules-load.d/k8s.conf`、sysctl は `/etc/sysctl.d/k8s.conf` に永続化済み。kubelet / containerd / tailscaled は systemd で enable されており、control plane（apiserver / etcd）は static pod なので kubelet が上がれば自動で復活する。

### 事前確認

```bash
# 再起動対象ノード（以降の手順はすべてこの変数を参照する）
export NODE=node2

# 自動起動の enable 確認（3 つとも enabled であること）
ssh "$NODE" 'systemctl is-enabled kubelet containerd tailscaled'

# tidb-public の Tailscale proxy Pod がどのノードに載っているか確認する。
# 再起動対象ノードに載っている場合、そのノード停止中は
# Fargate proxy → tidb.<tailnet>:4000 のブログ DB 経路が止まる
kubectl -n tailscale get pods -o wide

# クラスタが健全であること
kubectl get nodes
kubectl -n tidb-cluster get pods -o wide
```

### worker（node2 / node3）の再起動

```bash
kubectl cordon "$NODE"

# 【事前確認で ts-tidb-public が対象ノードに載っていた場合のみ】
# proxy Pod を消して別ノードへ退避させる（ブログ DB 経路のダウンを数十秒に抑える）。
# Tailscale のデバイス状態は Secret 保存のため、移動しても `tidb` の
# ホスト名・identity は維持される。SPOF 許容方針なので、退避せず数分止めてもよい
kubectl -n tailscale delete pod ts-tidb-public-<suffix>-0
kubectl -n tailscale get pods -o wide   # 別ノードで Running になるまで待つ

ssh "$NODE" 'sudo reboot'

# Ready に戻るまで待つ
kubectl get nodes -w

kubectl uncordon "$NODE"

# TiDB クラスタの Pod がすべて Running に戻るのを確認してから次のノードへ
kubectl -n tidb-cluster get pods -o wide
```

- `kubectl drain` でノード丸ごと退避するのは不可。TiKV / PD は local PV に紐付いていて他ノードへ移動できず、Pending で待つだけの無駄な churn が起きる。動かすのは tailscale proxy Pod だけでよい
- `ts-node-grafana-public` / `ts-tidb-dashboard-public` / tailscale operator / hubble-ui は退避不要。観測系なので再起動の数分止まっても実害はない（operator は既存 proxy の通信に関与しない）

### control plane（node1）の再起動

worker と同じ手順でよい。以下の点だけ異なる。

- 再起動中は kubectl が返らなくなるが正常。node1 の kubelet が上がると static pod（apiserver / etcd）が自動復旧し、kubectl も戻る
- kubectl が戻ったら **`kubectl uncordon node1` から手順を再開する**。`kubectl get nodes -w` の切断で手順が中断されるため uncordon を忘れやすい。忘れても既存 Pod は動き続けるので気付けず、後日 Pod を作り直したとき（TiKV rolling restart 等）に `volume node affinity conflict` で Pending になって発覚する（実績: 2026-07-05）
- アクセスの少ない時間帯に行う
- `ts-tidb-public` の proxy Pod が node1 に載っている場合、退避は**必ず再起動前に**行う。apiserver も同時に停止するため、落ちてからでは他ノードへ退避できず、ブログ DB 経路が node1 復帰まで止まる
- 万一 node1 のディスクが死ぬと etcd（クラスタ状態）を失う。TiDB のデータ自体は TiKV 3 レプリカなので無事

### 復帰確認

```bash
kubectl get nodes                          # 全ノード Ready。SchedulingDisabled が残っていたら uncordon 忘れ
kubectl -n kube-system get pods            # control plane / cilium / coredns が Running
kubectl -n tidb-cluster get pods -o wide   # PD / TiKV / TiDB が Running
kubectl -n tailscale get pods -o wide      # tidb-public の proxy Pod が Running
curl -s https://api.shuntaka.dev/health/db # ブログ DB 経路の疎通
```

## クエリリファレンス

### X-Ray（CloudWatch > トレース）

annotation キーはドットがアンダースコアに変換される。

| OTel 属性            | 検索キー                        |
| -------------------- | ------------------------------- |
| `app.route`          | `annotation.app_route`          |
| `cold_start`         | `annotation.cold_start`         |
| `db.query_type`      | `annotation.db_query_type`      |
| `db.statement_hash`  | `annotation.db_statement_hash`  |
| `proxy.close.reason` | `annotation.proxy_close_reason` |
| `error.type`         | `annotation.error_type`         |

`app.route` に入る値（axum の MatchedPath そのまま。health のルートは末尾スラッシュ付き `/health/` になる点に注意）:

| `app.route`                         | メソッド | 内容                                                                                             |
| ----------------------------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `/users/{name}/articles`            | GET      | 記事一覧（`tags` 指定時はタグ絞り込み。一覧 + COUNT + ページ内タグ取得の複数クエリ span が出る） |
| `/users/{name}/articles/tag-facets` | GET      | タグファセット集計（絞り込みパネル用。tags なしは `tag_article_counts` 前計算読み）              |
| `/users/{name}/articles/{slug}`     | GET      | 記事詳細                                                                                         |
| `/health/`                          | GET      | ヘルスチェック                                                                                   |
| `/health/db`                        | GET      | DB ヘルスチェック（5 分毎の SELECT 1 プローブが叩く）                                            |
| `/webhooks/github`                  | POST     | GitHub Webhook（記事同期。`tag_article_counts` の同期再計算 subsegment を含む）                  |
| `/swagger` ほか                     | GET      | Swagger UI（`/swagger/` / `/swagger/{*rest}` / `/swagger/openapi.json`）                         |

クエリサンプル:

| 用途                                                                   | クエリ                                                                                  |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 環境で絞る（X-Ray グループに登録しておくとドロップダウンで常時絞れる） | `service(id(name: "blog-api-prd"))`                                                     |
| 環境 + ルート                                                          | `service(id(name: "blog-api-prd")) AND annotation.app_route = "/users/{name}/articles"` |
| 遅いリクエスト（1 秒以上）                                             | `service(id(name: "blog-api-prd")) AND duration > 1`                                    |

## ハマりどころ

| 現象                                              | 原因                                                                                                                                                                                | 対処                                                                               |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 「SELECT 1 ベースライン」がデータなし             | 5 分毎プローブのテレメトリが Lambda freeze で大部分欠損する（実測 3 時間で 2/30 程度）                                                                                              | 仕様。対策候補は `/health/db` のみ応答前に同期 flush（未実装）                     |
| `_bucket` 系列が見つからない                      | OTLP histogram は native histogram のまま格納される                                                                                                                                 | `_bucket` / `sum by (le)` なしで `histogram_quantile` を書く                       |
| `rate()` で「name does not end in `_total`」警告  | counter の命名規約チェック                                                                                                                                                          | 無害。無視してよい                                                                 |
| 発生したはずのリクエストが `rate()` に出ない      | 1 サンプルしか持たない系列（1 回だけ invoke されたサンドボックス）は cumulative のため rate 計算できない                                                                            | リクエスト単位の悉皆データは X-Ray で見る                                          |
| `annotation.db_query_type` 等でヒットしない       | annotation 検索が効くのは segment（`lambda.handler` / `proxy.forward`）のみ。subsegment はインデックスされない                                                                      | ルートや duration で絞ってウォーターフォールで見る                                 |
| トレースマップで Lambda と forwarder が繋がらない | 生 TCP にトレースコンテキストを伝播できないため意図的に非連結                                                                                                                       | 時間軸で突き合わせる                                                               |
| `tidb-proxy` ノードのレイテンシが分単位           | TCP 接続（= MySQL セッション）の寿命を計測している                                                                                                                                  | リクエストレイテンシではないので正常                                               |
| `proxy.error.count` が 30 秒グリッドで常時 1〜5   | ECS ヘルスチェック（`nc -z`）の接続に forwarder が TiDB へ dial し、クローズ済みソケットへの greeting 書き戻しが forward_error になっていた。30 秒間隔 ~13ms のトレースノイズも同根 | forwarder が loopback からの接続を dial・テレメトリ対象外にして解消済み（2026-07） |
| ダッシュボードが "Something went wrong"           | chart ウィジェットの `plotOptions` 省略                                                                                                                                             | `observability-construct.ts` で対応済み。手でウィジェットを足すときは明示する      |
