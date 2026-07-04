# CloudWatch OTel Metrics と Classic メトリクスの機能差分

- 対象: blog-api / tidb-proxy の観測基盤（CloudWatch OTel Metrics 採用構成）
- 調査日: 2026-07-04
- 関連:
  - [OTel ボトルネック観測基盤](../tasks/2026-07-03-otel-bottleneck-observability.md)（OTel Metrics 採用の経緯とコスト比較）
  - [運用](../03_operations.md)（ダッシュボード・テレメトリ一覧・ハマりどころ）
- 参考:
  - [Introducing OpenTelemetry and PromQL support in Amazon CloudWatch (AWS Blog)](https://aws.amazon.com/blogs/mt/introducing-opentelemetry-promql-support-in-amazon-cloudwatch/)
  - [CloudWatch OpenTelemetry Metrics（公式ドキュメント）](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/metrics-otel-overview.html)
  - [Query metrics with PromQL — limits and restrictions](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-PromQL.html)
  - [Migrate from Classic to OTel metrics](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/metrics-otel-migrate.html)
  - [GA アナウンス (What's New, 2026-06)](https://aws.amazon.com/about-aws/whats-new/2026/06/amazon-cloudwatch-otel-metrics/)

## 背景

現状の監視は CloudWatch OTel Metrics（2026-06 GA の OTLP ネイティブ取り込み + PromQL クエリ）+ X-Ray で構成している。「CloudWatch Metrics を使っていない」のではなく、Classic なカスタムメトリクス（PutMetricData / EMF）ではなく OTel 側のストアを使っている。

採用時の比較（[タスクドキュメント](../tasks/2026-07-03-otel-bottleneck-observability.md)参照）は OTel 側の利点（コスト ~$10/月 → $1 未満/月、PromQL、dimension 管理不要）のみだったため、逆方向の「Classic だったらできたのにできないこと」を整理する。

## Classic (EMF) と比べてできないこと

### 1. 長期トレンドを 1 クエリで見られない（実害が最も大きい）

PromQL クエリは **1 リクエストの時間範囲が最大 7 日**（lookback 込み）。保存自体は 15 ヶ月だが 7 日窓でしか引けないため、「先月と今月の p95 比較」「リリース前後の週次トレンド」のような長期比較がダッシュボードやワンクエリでできない。Classic なら GetMetricData で 15 ヶ月分を一発で引けて、自動ロールアップ（1分 → 5分 → 1時間）も効く。

そのほかの PromQL 制限（2026-07 時点）:

| 制限                    | 値                    |
| ----------------------- | --------------------- |
| 最大時間範囲 / クエリ   | 7 日                  |
| 最大系列数 / クエリ     | 500（超過分は切詰め） |
| 実行タイムアウト        | 20 秒                 |
| クエリ TPS / アカウント | 300                   |

このワークロード規模では 7 日制限以外は実害が出にくい。

### 2. 単発リクエストがメトリクスから消える

temporality が cumulative のため、1 回だけ invoke されて消えた Lambda サンドボックスの系列（1 サンプルのみ）は `rate()` に反映されない。Classic の EMF ならデータポイント単位で必ず統計に現れるので、これは OTel 側を選んだことによる明確な劣化。

現状は「リクエスト単位の悉皆データは X-Ray で見る」で回避している（[運用のハマりどころ](../03_operations.md)参照）が、X-Ray にはサンプリングと保持期間の制約があり完全な代替ではない。

### 3. 従来のメトリクスコンソール・エコシステムに乗らない

Metrics Explorer や従来の「メトリクス」タブには出ず、Query Studio + PromQL 専用の世界になる。付随して:

- Auto Scaling の target tracking など「Classic メトリクス指定」前提の AWS サービス連携が使えない
- Metric Streams（Firehose 経由で Datadog 等へ転送）の対象になるかはドキュメント上未記載（おそらく対象外）
- 1 つのアラーム式・Metric Math 式の中で Classic メトリクス（Lambda 標準の Duration / Errors 等）と混在できるかは未確認（ダッシュボード上に別ウィジェットとして並べることは可能）

Lambda + 個人ブログという構成上、これらの実害は現時点でほぼゼロ。

## できなくなっていないもの

- **アラーム**: PromQL 式を `put-metric-alarm` の `--metrics` の `Expression` に入れる形で CloudWatch Alarms を作れる。SNS 通知・composite alarm も通常のアラームと同じ扱い
- **anomaly detection**: OTel メトリクス対応と公式に案内されている
- Amazon Managed Grafana / Prometheus 互換 API（`/api/v1/query` 等、SigV4 認証）からのクエリ
- 15 ヶ月保存（Classic と同等、追加料金なし）
- リージョン: ap-northeast-1 は OTLP ingest / PromQL / Query Studio すべて対応済み

PromQL アラームの例（[移行ガイド](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/metrics-otel-migrate.html)より）:

```bash
aws cloudwatch put-metric-alarm \
  --alarm-name "high-latency-otel" \
  --metrics '[{"Id":"q1","Expression":"avg(http_request_duration_seconds{path=\"/api/users\"}) * 1000","Period":300,"ReturnData":true}]' \
  --threshold 100 ...
```

## 結論

プラットフォームの機能差分で実害があるのは「7 日を超える長期トレンド比較」と「単発リクエストの `rate()` 欠落」の 2 点で、どちらも Classic に戻す理由にはならない（前者は 7 日窓を手動でずらせば見られる、後者は X-Ray で補完済み）。

それより大きいのは運用ギャップで、**現状アラームが 1 本も定義されていない**（`iac/aws/lib/api/observability-construct.ts` はダッシュボードとプローブのみ）。監視が「異常時に気づく」ではなく「見に行けば分かる」の状態。Classic に戻さなくても `proxy.error.count` や p95 の PromQL アラーム + SNS を足せば埋まる。
