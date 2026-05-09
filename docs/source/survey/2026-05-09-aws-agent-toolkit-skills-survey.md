# AWS Agent Toolkit skill 調査

- 対象: <https://github.com/aws/agent-toolkit-for-aws>
- 調査日: 2026-05-09
- 取り込み方針: `skills-lock.json` 経由（`npx skills add`）。MCP server / hook を含む Claude Code plugin（`/plugin install aws-core@...`）は採用しない。

## 本プロジェクトの AWS 利用面

CDK スタック (`iac/aws/`) を解析した範囲。

- Lambda（Rust / Docker image, ARM64, 15 分タイムアウト, JSON ログ）
- API Gateway (REST) + カスタムドメイン
- Route 53（A / エイリアス）
- ACM（東京リージョン TLS 証明書）
- Aurora DSQL（IAM 接続: `DbConnectAdmin`）
- SSM Parameter Store（DSQL 接続情報, GitHub App Secret, API URL）
- IAM（Lambda 実行ロール, GitHub Actions OIDC プロバイダ）
- CloudWatch Logs（2 週間リテンション, JSON フォーマット）

## skill 一覧

category アルファベット順 → name 順。1 列目は通し番号、推奨度は ◎ Highly recommended / ○ Optional / × Not needed、category 末尾の数字は当該 category 内の skill 総数。

| # | 推奨度 | category | name | description |
| ---: | --- | --- | --- | --- |
| 1 | × | analytics-7 | [aws-cleanrooms](https://github.com/aws/agent-toolkit-for-aws/blob/main/skills/analytics-skills/aws-cleanrooms/SKILL.md) | AWS Clean Rooms の IAM / S3 / KMS / Lake Formation / CloudWatch 周りのトラブルシュート。 |
| 2 | × | analytics-7 | [connecting-to-data-source](https://github.com/aws/agent-toolkit-for-aws/blob/main/skills/analytics-skills/connecting-to-data-source/SKILL.md) | AWS Glue で JDBC（Oracle, SQL Server, PostgreSQL, MySQL, RDS）/ Redshift / Snowflake / BigQuery への接続作成・診断。 |
| 3 | × | analytics-7 | [creating-data-lake-table](https://github.com/aws/agent-toolkit-for-aws/blob/main/skills/analytics-skills/creating-data-lake-table/SKILL.md) | Amazon S3 Tables で Iceberg マネージドテーブル作成。Glue Catalog 登録、自動 compaction とスナップショット管理。 |
| 4 | × | analytics-7 | [exploring-data-catalog](https://github.com/aws/agent-toolkit-for-aws/blob/main/skills/analytics-skills/exploring-data-catalog/SKILL.md) | Glue Data Catalog を S3 Tables / Redshift / Iceberg を含めてインベントリ・監査。 |
| 5 | × | analytics-7 | [finding-data-lake-assets](https://github.com/aws/agent-toolkit-for-aws/blob/main/skills/analytics-skills/finding-data-lake-assets/SKILL.md) | Glue / S3 / S3 Tables / Redshift にまたがるデータレイク資産の探索。 |
| 6 | × | analytics-7 | [ingesting-into-data-lake](https://github.com/aws/agent-toolkit-for-aws/blob/main/skills/analytics-skills/ingesting-into-data-lake/SKILL.md) | S3 / JDBC DB / Redshift / Snowflake / BigQuery / DynamoDB / Glue から AWS データレイクへ取り込み。 |
| 7 | × | analytics-7 | [querying-data-lake](https://github.com/aws/agent-toolkit-for-aws/blob/main/skills/analytics-skills/querying-data-lake/SKILL.md) | Athena SQL（Glue / S3 Tables / Redshift federated）の実行・管理。 |
| 8 | × | application-integration-1 | [aws-messaging-and-streaming](https://github.com/aws/agent-toolkit-for-aws/blob/main/skills/application-integration-skills/aws-messaging-and-streaming/SKILL.md) | SQS / SNS / EventBridge / MQ / Kinesis Data Streams / Data Firehose / MSK Apache Flink などのメッセージ・ストリーミング統合ガイド。 |
| 9 | × | cloud-financial-management-1 | [aws-billing-and-cost-management](https://github.com/aws/agent-toolkit-for-aws/blob/main/skills/cloud-financial-management-skills/aws-billing-and-cost-management/SKILL.md) | AWS コスト分析・予算・Savings Plans / RI 評価・Compute Optimizer での EC2/Lambda/RDS/EBS 適正化、CUR を Athena でクエリ。 |
| 10 | × | compute-10 | [aws-containers](https://github.com/aws/agent-toolkit-for-aws/blob/main/skills/compute-skills/aws-containers/SKILL.md) | ECS / Fargate / ECR でのコンテナワークロード運用。タスク定義、ECS Exec デバッグ、サービススケーリング。 |
| 11 | × | compute-10 | [aws-serverless](https://github.com/aws/agent-toolkit-for-aws/blob/main/skills/compute-skills/aws-serverless/SKILL.md) | Lambda / API Gateway / Step Functions / EventBridge を SAM / CDK で構築・デバッグ。コールドスタート、CORS、イベントなど。 |
| 12 | ◎ | compute-10 | [connecting-lambda-to-api-gateway](https://github.com/aws/agent-toolkit-for-aws/blob/main/skills/compute-skills/connecting-lambda-to-api-gateway/SKILL.md) | 既存 Lambda を REST / HTTP API Gateway に接続。リソース・メソッド・proxy 統合・権限・デプロイ。 |
| 13 | × | compute-10 | [connecting-lambda-to-dynamodb](https://github.com/aws/agent-toolkit-for-aws/blob/main/skills/compute-skills/connecting-lambda-to-dynamodb/SKILL.md) | Lambda と DynamoDB を IAM / ストリーム event source mapping で連携。 |
| 14 | ○ | compute-10 | [creating-api-gateway-stage](https://github.com/aws/agent-toolkit-for-aws/blob/main/skills/compute-skills/creating-api-gateway-stage/SKILL.md) | API Gateway の stage 作成。CloudWatch logging、X-Ray、throttling、WAF、IAM ロール。 |
| 15 | × | compute-10 | [creating-ec2-image-builder-pipeline](https://github.com/aws/agent-toolkit-for-aws/blob/main/skills/compute-skills/creating-ec2-image-builder-pipeline/SKILL.md) | EC2 Image Builder で AMI ビルドパイプラインとリージョン配布、launch template 作成。 |
| 16 | ○ | compute-10 | [debugging-lambda-timeouts](https://github.com/aws/agent-toolkit-for-aws/blob/main/skills/compute-skills/debugging-lambda-timeouts/SKILL.md) | Lambda タイムアウト系障害を設定 / CloudWatch logs / VPC / コールドスタート / メモリ / 下流依存から系統的に切り分け。 |
| 17 | × | compute-10 | [launching-ec2-instance-with-best-practices](https://github.com/aws/agent-toolkit-for-aws/blob/main/skills/compute-skills/launching-ec2-instance-with-best-practices/SKILL.md) | EC2 をセキュアかつコスト効率良く起動（AMI 選定 / バースト型サイジング / 最小権限 IAM / SG / EBS 暗号化）。 |
| 18 | ○ | compute-10 | [routing-traffic-with-route53-and-cloudfront](https://github.com/aws/agent-toolkit-for-aws/blob/main/skills/compute-skills/routing-traffic-with-route53-and-cloudfront/SKILL.md) | Route 53 で CloudFront へのカスタムドメイン alias 設定。ACM 証明書、CNAME、HTTPS。 |
| 19 | × | compute-10 | [setting-up-ec2-instance-profiles](https://github.com/aws/agent-toolkit-for-aws/blob/main/skills/compute-skills/setting-up-ec2-instance-profiles/SKILL.md) | EC2 から AWS API を呼ぶための instance profile / IAM ロール構成（資格情報ハードコード排除）。 |
| 20 | × | database-2 | [creating-amazon-aurora-db-cluster-with-instances](https://github.com/aws/agent-toolkit-for-aws/blob/main/skills/database-skills/creating-amazon-aurora-db-cluster-with-instances/SKILL.md) | Aurora クラスタ + インスタンス + Secrets Manager のパスワード管理を順序立てて作成。 |
| 21 | × | database-2 | [exporting-rds-to-s3](https://github.com/aws/agent-toolkit-for-aws/blob/main/skills/database-skills/exporting-rds-to-s3/SKILL.md) | RDS / Aurora スナップショットを S3 へ Parquet エクスポート。IAM、KMS、運用手順。 |
| 22 | ◎ | developer-tools-4 | [aws-cdk](https://github.com/aws/agent-toolkit-for-aws/blob/main/skills/developer-tools-skills/aws-cdk/SKILL.md) | CDK (TypeScript / Python) で IaC を書く・デプロイ・診断。ベストプラクティス、stack 構成、construct パターン。 |
| 23 | ○ | developer-tools-4 | [aws-sdk-js-v3-usage](https://github.com/aws/agent-toolkit-for-aws/blob/main/skills/developer-tools-skills/aws-sdk-js-v3-usage/SKILL.md) | AWS SDK for JavaScript v3 (`@aws-sdk/*`) の利用パターン。スキーマ、リトライ、ページング、認証。 |
| 24 | × | developer-tools-4 | [aws-sdk-python-usage](https://github.com/aws/agent-toolkit-for-aws/blob/main/skills/developer-tools-skills/aws-sdk-python-usage/SKILL.md) | boto3 利用パターン。session、リトライ、ページング、シリアライズ、認証。 |
| 25 | × | developer-tools-4 | [aws-sdk-swift-usage](https://github.com/aws/agent-toolkit-for-aws/blob/main/skills/developer-tools-skills/aws-sdk-swift-usage/SKILL.md) | AWS SDK for Swift の利用パターン。async、エラー処理、モデリング。 |
| 26 | × | frontend-1 | [aws-amplify](https://github.com/aws/agent-toolkit-for-aws/blob/main/skills/frontend-skills/aws-amplify/SKILL.md) | Amplify Gen 2（TypeScript first / CDK ベース）でのフルスタック開発。Cognito、AppSync、Storage 等。 |
| 27 | × | generative-ai-1 | [amazon-bedrock](https://github.com/aws/agent-toolkit-for-aws/blob/main/skills/generative-ai-skills/amazon-bedrock/SKILL.md) | Bedrock で生成 AI アプリ構築。Converse API、Knowledge Bases RAG、Agents、Guardrails、AgentCore。 |
| 28 | ○ | management-tools-1 | [aws-cloudformation](https://github.com/aws/agent-toolkit-for-aws/blob/main/skills/management-tools-skills/aws-cloudformation/SKILL.md) | CloudFormation テンプレートの作成・検証・診断。cfn-lint / cfn-guard / change set。 |
| 29 | × | migration-and-modernization-1 | [aws-transform](https://github.com/aws/agent-toolkit-for-aws/blob/main/skills/migration-and-modernization-skills/aws-transform/SKILL.md) | AWS Transform (ATX) CLI で言語バージョンアップ / SDK 移行 / フレームワーク移行（Angular, Vue, Spring Boot 等）。 |
| 30 | × | networking-and-content-delivery-4 | [configuring-vpc-endpoints-for-private-aws-service-access](https://github.com/aws/agent-toolkit-for-aws/blob/main/skills/networking-and-content-delivery-skills/configuring-vpc-endpoints-for-private-aws-service-access/SKILL.md) | PrivateLink で VPC エンドポイント（interface / gateway）を構成し AWS サービスへプライベート接続。 |
| 31 | × | networking-and-content-delivery-4 | [connecting-vpcs-with-peering](https://github.com/aws/agent-toolkit-for-aws/blob/main/skills/networking-and-content-delivery-skills/connecting-vpcs-with-peering/SKILL.md) | 2 つの VPC を peering 接続。CIDR 重複検証、ルートテーブル更新。 |
| 32 | × | networking-and-content-delivery-4 | [creating-production-vpc-multi-az](https://github.com/aws/agent-toolkit-for-aws/blob/main/skills/networking-and-content-delivery-skills/creating-production-vpc-multi-az/SKILL.md) | Public / Private subnet を Multi-AZ で持つ本番 VPC を Well-Architected に基づき構築。 |
| 33 | × | networking-and-content-delivery-4 | [enabling-lambda-vpc-internet-access](https://github.com/aws/agent-toolkit-for-aws/blob/main/skills/networking-and-content-delivery-skills/enabling-lambda-vpc-internet-access/SKILL.md) | VPC Lambda にインターネット接続を付与（NAT Gateway、サブネット、SG）。 |
| 34 | ◎ | operations-4 | [aws-observability](https://github.com/aws/agent-toolkit-for-aws/blob/main/skills/operations-skills/aws-observability/SKILL.md) | CloudWatch Logs Insights / Metrics / Alarms / Dashboards / EMF / X-Ray / CloudTrail / ADOT の利用と最適化。 |
| 35 | × | operations-4 | [setting-up-cloudtrail-multi-region](https://github.com/aws/agent-toolkit-for-aws/blob/main/skills/operations-skills/setting-up-cloudtrail-multi-region/SKILL.md) | マルチリージョン CloudTrail。S3 ログ保存、CloudWatch Logs 連携、Insights クエリ。 |
| 36 | ○ | operations-4 | [setting-up-cloudwatch-alarm-notifications](https://github.com/aws/agent-toolkit-for-aws/blob/main/skills/operations-skills/setting-up-cloudwatch-alarm-notifications/SKILL.md) | CloudWatch アラームの通知チャネル（暗号化 SNS、トピックポリシー、サブスクリプション）。 |
| 37 | ○ | operations-4 | [troubleshooting-application-failures](https://github.com/aws/agent-toolkit-for-aws/blob/main/skills/operations-skills/troubleshooting-application-failures/SKILL.md) | アプリ障害時に CloudWatch ロググループを発見・分析してエラーパターンと根本原因を特定。 |
| 38 | ◎ | security-and-identity-2 | [aws-iam](https://github.com/aws/agent-toolkit-for-aws/blob/main/skills/security-and-identity-skills/aws-iam/SKILL.md) | エージェントが間違えがちな IAM の挙動（policy 評価のエッジケース、trust policy、STS、Organizations、SAML / MFA）への補正。 |
| 39 | ○ | security-and-identity-2 | [creating-secrets-using-best-practices](https://github.com/aws/agent-toolkit-for-aws/blob/main/skills/security-and-identity-skills/creating-secrets-using-best-practices/SKILL.md) | Secrets Manager のベストプラクティス（専用 KMS 鍵、自動ローテーション、最小権限）。 |
| 40 | × | storage-4 | [securing-s3-buckets](https://github.com/aws/agent-toolkit-for-aws/blob/main/skills/storage-skills/securing-s3-buckets/SKILL.md) | S3 バケットのアクセス制御 / 暗号化 / 監視 / 設定不備の修復。 |
| 41 | × | storage-4 | [storing-and-querying-vectors](https://github.com/aws/agent-toolkit-for-aws/blob/main/skills/storage-skills/storing-and-querying-vectors/SKILL.md) | S3 Vectors（`s3vectors` API）でベクトル埋め込みを保存・クエリ。 |
| 42 | × | storage-4 | [troubleshooting-efs](https://github.com/aws/agent-toolkit-for-aws/blob/main/skills/storage-skills/troubleshooting-efs/SKILL.md) | EFS の mount 失敗、NFS タイムアウト、権限、スループット、burst credit 枯渇を診断。 |
| 43 | × | storage-4 | [troubleshooting-s3-files](https://github.com/aws/agent-toolkit-for-aws/blob/main/skills/storage-skills/troubleshooting-s3-files/SKILL.md) | S3 Files のマウント / 権限 / 同期 / 性能の問題を診断。 |

> 注: DSQL 専用 skill は現状なし。

## 取り込みコマンド

AWS Toolkit は `skills/<category>/<name>/SKILL.md` の入れ子構造のため `--full-depth` が必要（無いと 50 件中 27 件しか検出されない）。`bunx skills add` の package 引数は `<owner>/<repo>` のみで、パスは渡せない。

◎ Highly recommended の 4 件。

```bash
bunx skills add aws/agent-toolkit-for-aws --skill aws-cdk -a claude-code -y --full-depth
bunx skills add aws/agent-toolkit-for-aws --skill connecting-lambda-to-api-gateway -a claude-code -y --full-depth
bunx skills add aws/agent-toolkit-for-aws --skill aws-iam -a claude-code -y --full-depth
bunx skills add aws/agent-toolkit-for-aws --skill aws-observability -a claude-code -y --full-depth
```

○ Optional の 8 件。

```bash
bunx skills add aws/agent-toolkit-for-aws --skill creating-api-gateway-stage -a claude-code -y --full-depth
bunx skills add aws/agent-toolkit-for-aws --skill debugging-lambda-timeouts -a claude-code -y --full-depth
bunx skills add aws/agent-toolkit-for-aws --skill routing-traffic-with-route53-and-cloudfront -a claude-code -y --full-depth
bunx skills add aws/agent-toolkit-for-aws --skill aws-sdk-js-v3-usage -a claude-code -y --full-depth
bunx skills add aws/agent-toolkit-for-aws --skill aws-cloudformation -a claude-code -y --full-depth
bunx skills add aws/agent-toolkit-for-aws --skill setting-up-cloudwatch-alarm-notifications -a claude-code -y --full-depth
bunx skills add aws/agent-toolkit-for-aws --skill troubleshooting-application-failures -a claude-code -y --full-depth
bunx skills add aws/agent-toolkit-for-aws --skill creating-secrets-using-best-practices -a claude-code -y --full-depth
```

実行後、`skills-lock.json` に `source: aws/agent-toolkit-for-aws`、`sourceType: github`、`skillPath: skills/<category>-skills/<name>/SKILL.md`、`computedHash: ...` の各エントリが追加される（既存 vercel エントリと同じ形式）。
