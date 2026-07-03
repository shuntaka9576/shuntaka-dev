# 運用

blog-api (Lambda) 〜 tidb-proxy (forwarder) 〜 TiDB 経路で「遅い・おかしい」が起きたときに、原因箇所を最短で切り分けるための手順。設計・デプロイ手順は [OTel ボトルネック観測基盤](tasks/2026-07-03-otel-bottleneck-observability.md) を参照。

## 症状別インデックス

| 症状                           | 見る節                 |
| ------------------------------ | ---------------------- |
| API / ブログが遅い             | ボトルネック切り分け   |
| グラフの意味を知りたい         | ダッシュボード         |
| ダッシュボードにデータが出ない | テレメトリが出ないとき |
| クエリの書き方を調べたい       | クエリリファレンス     |
| 検索がヒットしない・表示が変   | ハマりどころ           |

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

| `app.route`                     | メソッド | 内容                                                                     |
| ------------------------------- | -------- | ------------------------------------------------------------------------ |
| `/users/{name}/articles`        | GET      | 記事一覧                                                                 |
| `/users/{name}/articles/{slug}` | GET      | 記事詳細                                                                 |
| `/health/`                      | GET      | ヘルスチェック                                                           |
| `/health/db`                    | GET      | DB ヘルスチェック（5 分毎の SELECT 1 プローブが叩く）                    |
| `/webhooks/github`              | POST     | GitHub Webhook（記事同期）                                               |
| `/swagger` ほか                 | GET      | Swagger UI（`/swagger/` / `/swagger/{*rest}` / `/swagger/openapi.json`） |

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
