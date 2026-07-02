# blog-api: OTel によるボトルネック観測基盤 (Lambda〜TiDB 経路)

- 起票日: 2026-07-03
- ステータス: 実装済み・デプロイ待ち（手動作業は本書の「手動作業」節）
- 関連 PR: [#523](https://github.com/shuntaka9576/shuntaka-dev/pull/523)
- 関連実装:
  - `apps/blog-api/shared/src/telemetry.rs`（OTel SDK 初期化）
  - `apps/blog-api/api/src/observability.rs`（リクエスト計装）
  - `apps/blog-api/adapter/src/observability.rs`（DB 計装）
  - `apps/blog-api/infrastructure/src/observability.rs`（外部 API 計装）
  - `apps/tidb-proxy/cmd/forwarder/otel.go`（forwarder 計装）
  - `iac/aws/ecspresso/tidb-proxy/otel-config.yaml`（ADOT Collector 設定）
  - `iac/aws/lib/api/observability-construct.ts`（ダッシュボード + プローブ）

## 目的

Lambda から自宅 TiDB までのリクエスト経路のうち、レイテンシがどこで発生しているかを切り分けられるようにする。

- Lambda アプリ処理
- DB 接続確立
- Tailscale / ネットワーク経路
- ECS forwarder
- TiDB SQL 実行（TiKV / PD 含む）

アプリ / proxy 側は OpenTelemetry で計測し、TiDB 内部は既存の TiDB Dashboard / Statement Summary / Slow Query を使う。両者を同一時間軸で突き合わせて判定する。

## アーキテクチャ

```
Client / API Gateway
  └─ Lambda (blog-api, Rust + LWA)
      │  DATABASE_URL = mysql://tidb-proxy.internal:13306/...
      │  OTEL_EXPORTER_OTLP_ENDPOINT = http://tidb-proxy.internal:4318
      └─ ECS Fargate task: tidb-proxy
          ├─ tidb-forwarder (Go, tsnet) ──→ tidb.<tailnet>:4000 (TiDB)
          │     └─ OTLP/gRPC → localhost:4317
          ├─ squid (3128)
          └─ otel-collector (ADOT, essential: false)
                ├─ traces  → X-Ray (awsxray exporter)
                └─ metrics → CloudWatch OTel Metrics
                             (otlphttp + sigv4auth →
                              monitoring.ap-northeast-1.amazonaws.com/v1/metrics)
```

- Lambda はコンテナイメージ Lambda のため ADOT Lambda layer は使えない。collector を Lambda イメージに焼き込むとコールドスタート（= 計測対象）を汚すため、**常駐している tidb-proxy task に collector を同居**させ、Lambda は VPC 越しに OTLP/HTTP で送る
- collector は `essential: false`。死んでもテレメトリが途切れるだけで、本番経路 (MySQL forward) には影響しない
- アプリ側 SDK はすべて upstream OTel。`OTEL_EXPORTER_OTLP_ENDPOINT` 未設定なら完全に無効化されるため、ローカル開発に影響なし

## 計装内容

### Span

| Span                     | 場所                        | 主な属性                                                                 |
| ------------------------ | --------------------------- | ------------------------------------------------------------------------ |
| `lambda.handler`         | Lambda (route_layer)        | `app.route`, `cold_start`, `http.response.status_code`                   |
| `db.connect`             | Lambda (pool 生成)          | `db.system`, `db.name`, `net.peer.name`                                  |
| `db.query`               | Lambda (全リポジトリの SQL) | `db.query_type`, `db.operation`, `db.statement_hash`, `db.rows_returned` |
| `db.healthcheck`         | Lambda (`SELECT 1`)         | `db.query_type=select_1`                                                 |
| `external.request`       | Lambda (GitHub API)         | `peer.service`, `external.operation`, `url.template`                     |
| `proxy.forward`          | forwarder (TCP 接続の一生)  | `proxy.close.reason`, `proxy.bytes.in/out`, `net.peer.ip`                |
| `proxy.accept`           | forwarder                   | accept 直後のマーカー                                                    |
| `proxy.upstream.connect` | forwarder (`ts.Dial`)       | `proxy.upstream.name`, `error.type`                                      |

生 SQL・バインド値・トークンは span に入れない。SQL は正規化後ハッシュ (`db.statement_hash`) と論理名 (`db.query_type`) で識別し、TiDB の statement digest と突き合わせる。

### Metrics

| メトリクス                                  | 型        | 意味                               |
| ------------------------------------------- | --------- | ---------------------------------- |
| `app.request.duration`                      | histogram | Lambda リクエスト処理時間          |
| `lambda.cold_start.count`                   | counter   | cold start 回数                    |
| `db.connection.duration`                    | histogram | DB 接続確立時間                    |
| `db.query.duration`                         | histogram | クライアント視点のクエリレイテンシ |
| `db.healthcheck.duration`                   | histogram | `SELECT 1` ベースライン            |
| `db.query.error.count`                      | counter   | DB クエリエラー                    |
| `proxy.connection.active`                   | gauge     | アクティブ接続数                   |
| `proxy.connection.accept.count`             | counter   | accept 数                          |
| `proxy.upstream.connect.duration`           | histogram | forwarder→TiDB 接続時間            |
| `proxy.connection.duration`                 | histogram | 接続の生存時間                     |
| `proxy.bytes.in` / `proxy.bytes.out`        | counter   | 転送バイト数                       |
| `proxy.error.count` / `proxy.timeout.count` | counter   | エラー / タイムアウト              |

## メトリクス基盤: CloudWatch OTel Metrics (OTLP ネイティブ)

当初は ADOT の awsemf exporter で Classic メトリクス (EMF) に送る構成だったが、2026-06-16 GA の **CloudWatch OTel Metrics** に移行した。

| 観点           | Classic (EMF)                             | OTel Metrics (採用)                                  |
| -------------- | ----------------------------------------- | ---------------------------------------------------- |
| 課金           | ユニークメトリクス数 × $0.30/月 (~$10/月) | 取り込み GB ベース (このワークロードでは $1 未満/月) |
| クエリ         | Metric Math                               | PromQL (`histogram_quantile` 等)                     |
| dimension 制御 | metric_declarations で厳密に管理          | 不要 (150 ラベルまで)                                |

PromQL 上の見え方:

- ドット入りメトリクス名は引用構文で参照する: `{"db.query.duration_bucket", "@resource.service.name"="blog-api-prd"}`
- OTLP histogram は `<name>_bucket` 系列 + `le` ラベルになり `histogram_quantile` が使える
- resource 属性は `@resource.service.name` 等のラベルになる

ダッシュボードの p95 クエリ例:

```
histogram_quantile(0.95, sum by (le) (rate({"db.query.duration_bucket", "@resource.service.name"="blog-api-prd"}[15m])))
```

## 設計判断・注意点

- **temporality は cumulative**（PromQL の `rate()` / `histogram_quantile()` 前提）。並行する Lambda サンドボックスやローリング中の ECS task が同一ラベルで cumulative 値を吐くと混線するため、**`service.instance.id` をリソース属性に付与**してプロセス単位で系列を分離している
- **Lambda freeze 対策**: batch export だけに頼らず、レスポンス返却後に別スレッドで `force_flush` する。freeze で送り損ねた分は次 invoke で送信される
- **1 サンプルしか持たない系列**（1 回 invoke されて消えたサンドボックス等）は `rate()` に反映されない。リクエスト単位の悉皆データは X-Ray トレース側で見る
- **`SELECT 1` ベースラインは EventBridge API Destination が 5 分毎に `/health/db` を叩いて供給**する。毎分にすると Lambda が常時 warm になり cold start が観測できなくなるため 5 分にしている
- Lambda の `NO_PROXY` に `tidb-proxy.internal` を追加している。OTLP 送信が squid (HTTP_PROXY) を経由しないようにするため
- task メモリは 512 MB のまま (squid + forwarder + collector の 3 コンテナ同居)。collector が OOM でメモリ不足になる場合は task メモリ増量を検討する
- CloudWatch OTLP metrics エンドポイントは 1 リクエスト 1,000 datapoint / 1MB 制限があるため、collector の metrics パイプラインは `batch/metrics` (send_batch_max_size: 800) を使う

## 手動作業（デプロイ手順）

### 1. CloudWatch の OTLP ingestion 有効化（アカウント初回のみ）

CloudWatch コンソール (ap-northeast-1) → Settings で OpenTelemetry (OTLP) metrics ingestion が有効かを確認し、無効なら有効化する。

未有効のまま送信すると collector ログ (`/ecs/tidb-proxy` の `otel-collector` prefix) に 4xx が出るので、疎通確認はそこで行う。

### 2. tidb-proxy スタックのデプロイ（IAM 変更）

task role への X-Ray 書き込み + `cloudwatch:PutMetricData` 付与。

```bash
cd iac/aws
export STAGE_NAME=prd  # proxy スタックは stage 共用だが getConfig() の実行に必要
bunx dotenv -- cdk deploy \
  -c stageName=${STAGE_NAME} \
  st-tidb-proxy \
  --require-approval never
```

### 3. tidb-proxy イメージ更新 + ecspresso deploy（collector sidecar 追加）

forwarder の OTel 計装入りイメージを push し、otel-collector sidecar 入りの task def を反映する。

```bash
scripts/deploy-tidb-proxy.sh
```

### 4. main スタックのデプロイ（dev / prd）

Lambda 環境変数 (`OTEL_*`, `NO_PROXY`) / SG 4318 / ダッシュボード / ヘルスチェックプローブ。

```bash
cd iac/aws
for STAGE_NAME in dev prd; do
  bunx dotenv -- cdk deploy \
    -c stageName=${STAGE_NAME} \
    ${STAGE_NAME:0:1}-st-main \
    --require-approval never
done
```

### 5. デプロイ後の確認

1. collector 起動確認: `/ecs/tidb-proxy` ロググループの `otel-collector` prefix にエラーが無いこと
2. トレース確認: X-Ray コンソールで `lambda.handler` 配下に `db.query` / `db.healthcheck` がぶら下がる 1 リクエスト 1 トレースが見えること
3. **メトリクス名の実地確認**: CloudWatch Query Studio で以下を実行し、系列が返ることを確認する

   ```
   {"db.healthcheck.duration_bucket"}
   ```

   histogram の `_bucket` サフィックスは公式ドキュメント + AWS ブログの例に基づく想定のため、**実データで名前が違っていた場合は `iac/aws/lib/api/observability-construct.ts` のクエリだけ修正**する（構造はクエリ文字列を差し替えるだけで済むようにしてある）

4. ダッシュボード確認: `d-st-observability` / `p-st-observability` で p50/p95/p99 が描画されること（プローブが 5 分毎なので初回データまで最大 ~15 分待つ）
5. TiDB Dashboard の statement duration と CloudWatch を同一時間窓で並べ、突き合わせができること

### 6. 運用上の手動作業（継続）

- 新規追加の恒常的な手動運用は無し。Tailscale auth key の 90 日ローテーション（既存運用）のみ
- コスト観点で外したくなったら: collector sidecar を task def から外せばメトリクス課金は止まる（アプリ側計装は endpoint 未設定なら no-op なので残してよい）

## ボトルネック分析の読み方

`db.healthcheck.duration` (SELECT 1 = 経路コストのみ) と `db.query.duration` (経路 + SQL 実行 + 結果転送) と TiDB statement duration の 3 つを比較する。

| 観測結果                                                | ボトルネック                                                   |
| ------------------------------------------------------- | -------------------------------------------------------------- |
| SELECT 1 も実クエリも遅い                               | Tailscale / ネットワーク / forwarder / 接続経路                |
| SELECT 1 は速く実クエリだけ遅い                         | SQL / インデックス / TiDB 実行 / TiKV / 結果サイズ             |
| クライアント計測は高いが TiDB statement duration は低い | ネットワーク / forwarder / 結果転送                            |
| クライアント計測も TiDB も高い                          | SQL / TiDB / TiKV 側                                           |
| `db.connection.duration` だけ高い                       | 接続確立 / pool / Tailscale 経路 / TLS                         |
| forwarder の `proxy.upstream.connect.duration` が高い   | forwarder → TiDB 経路                                          |
| forwarder に reset / timeout が多い                     | ネットワーク不安定 / idle timeout / Lambda freeze との相互作用 |

## コスト

| 項目                                  | 月額 (USD) |
| ------------------------------------- | ---------- |
| CloudWatch OTel Metrics (取り込み GB) | < $1       |
| X-Ray (無料枠 10 万トレース/月)       | $0         |
| EventBridge プローブ + Lambda/API GW  | ~$0.1      |
| 合計                                  | **~$1/月** |
