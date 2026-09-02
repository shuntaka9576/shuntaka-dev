<!-- cspell:ignore Unblended -->

# tidb-proxy: ログを FireLens で振り分けて S3/Iceberg + Athena で検索可能にする

- 起票日: 2026-07-10
- 移行元: 全コンテナログを awslogs driver で CloudWatch Logs `/ecs/tidb-proxy` に集約
- 移行先: FireLens (Fluent Bit) で INFO 系を Firehose → Iceberg (S3 + Glue) へ、WARN/ERROR・非JSON行を CloudWatch Logs へ振り分け
- 対象環境: **dev / prd 共用**（tidb-proxy 自体が共用 1 task のため、ログ基盤も 1 セット）
- ステータス: 実装済み
- 関連タスク: [blog-api: Lambda + tsnet を VPC + Fargate Proxy 構成に移行](../2026-06-29-blog-api-tidb-proxy/index.md)
- 関連実装: `apps/tidb-proxy/`, `iac/aws/lib/analytics/`, `iac/aws/ecspresso/tidb-proxy/`

## 概要

tidb-proxy (squid + Go forwarder 同居の Fargate task) のログは現状 awslogs driver で CloudWatch Logs に全量流れるだけで、squid のアクセス記録を後から分析する手段が実質 CloudWatch Logs Insights しかない。本タスクで以下に切り替える。

1. **アプリのログを JSON 構造化**する（forwarder は `log/slog`、squid はカスタム `logformat`）
2. タスクに **FireLens (Fluent Bit) サイドカー**を追加し、`level` で宛先を振り分ける
   - `INFO` / squid アクセスログ → **Amazon Data Firehose → Iceberg テーブル (S3 + Glue Data Catalog)**
   - `WARN` / `ERROR` / JSON パース不能行 (tsnet 内部ログ・squid cache_log) → **CloudWatch Logs** (`/ecs/tidb-proxy`、従来どおり障害調査用)
3. Iceberg テーブルは **Athena** (WorkGroup `tidb-proxy-logs`) で検索する

### 設計判断の前提

- **カスタム Fluent Bit イメージは作らない**。`aws-for-fluent-bit` の `init` タグイメージは Fargate でも起動時に S3 から設定ファイルを取得できるため、設定は S3 配置 (`BucketDeployment` で git と同期) で済ませ、ECR リポジトリ追加とイメージビルドのパイプラインを持たない
- **S3 Tables は使わない**。マネージドコンパクションは魅力だが Lake Formation 統合の設定が増える。このデータ量 (月数十〜数百MB) ではコンパクション自体が当面不要なため、通常 S3 + Glue Catalog の Iceberg テーブルで開始する
- **Kinesis Data Streams は使わない**。Firehose Direct PUT で十分（シャード時間課金なし、完全従量）

## アーキテクチャ

### Before (現行)

```
Task: tidb-proxy
├─ tidb-proxy コンテナ (squid + forwarder)
│   └─ stdout/stderr ── awslogs driver ──→ CloudWatch Logs /ecs/tidb-proxy (全量)
└─ otel-collector (ADOT)
    └─ stdout/stderr ── awslogs driver ──→ CloudWatch Logs /ecs/tidb-proxy
```

### After (本タスク)

```
Task: tidb-proxy
├─ tidb-proxy コンテナ (squid + forwarder, JSON ログ化)
│   └─ stdout/stderr ── awsfirelens driver ──┐
├─ log-router (aws-for-fluent-bit:init-*)    │
│   ├─ 起動時に S3 から extra.conf を取得 ←──┼── s3://tidb-proxy-logs-<account>/firelens-config/
│   ├─ level=WARN/ERROR・非JSON行 ──────────→ CloudWatch Logs /ecs/tidb-proxy
│   └─ level=INFO・squid_access ────────────→ Firehose tidb-proxy-logs (Direct PUT)
│                                               └→ Iceberg: tidb_proxy_logs.logs
│                                                   (s3://tidb-proxy-logs-<account>/iceberg/logs/)
│                                                   ← Athena WorkGroup tidb-proxy-logs で検索
└─ otel-collector (ADOT, awslogs のまま無変更)
```

- squid アクセスログ (stdout) は logformat で `log_type=squid_access` / `level=INFO` を埋め込む
- forwarder は slog JSON (`log_type=forwarder`) で、通常ログは INFO、エラー系は WARN/ERROR
- tsnet 内部ログ・squid cache_log (stderr) は非 JSON のまま → Fluent Bit の JSON パースに失敗した行として CloudWatch Logs にフォールバック（安全側）

## コスト試算

東京リージョン、ログ量は月 1GB と多めに見積もった場合（実際は月数十〜数百MB 想定）。

| 要素                                   | 単価                              | 月額 (USD)   |
| -------------------------------------- | --------------------------------- | ------------ |
| Firehose Direct PUT → Iceberg 配信     | ~$0.075/GB（5KB 切り上げなし）    | ~$0.08       |
| S3 (Parquet 保存 + PUT/GET リクエスト) | $0.025/GB-月 + リクエスト         | ~$0.05       |
| Glue Data Catalog                      | 100万オブジェクト/リクエスト無料  | $0           |
| Athena                                 | $5/TB スキャン（最低 10MB/query） | 月数円       |
| CloudWatch Logs 取り込み               | INFO 分 ($0.76/GB) が消える       | 削減方向     |
| VPC Endpoint                           | task に public 疎通があり不要     | $0           |
| **合計**                               |                                   | **月十数円** |

条件付きの増分として、タスクメモリを 512MB → 1024MB に上げる場合のみ +約$1.6/月 (ARM $0.0044/GB-h × 0.5GB × 730h)。

### 2026-09-02: 8月実績と9月予測

初期試算後、Firehose が約60秒ごとに作成する Iceberg metadata JSON と snapshot が累積し、S3料金が想定を大きく上回った。原因と VACUUM 対応の詳細は [tidb-proxy Iceberg メタデータによる S3 高額化の調査と対応](../2026-08-23-tidb-proxy-iceberg-s3-cost/index.md) を参照。

2026-09-02 時点の Cost Explorer では8月分はまだ `Estimated=true` である。

| 項目                        | 8月実績 (USD) |
| --------------------------- | ------------: |
| AWS 全体（Tax $3.84を含む） |    $42.227671 |
| S3 全体                     |    $22.424590 |
| S3 Standard Storage         |    $21.237915 |
| S3 Tier 1 requests          |     $0.733515 |
| S3 Tier 2 requests          |     $0.451658 |

S3 Standard Storage の8月使用量は `849.516600 GB-Month`。対象バケットの live objects は約333.0 GBで、そのうち実ログデータは約0.314 GB、Iceberg metadataは約332.67 GBだった。

バケット容量は2026-08-23の約1.70 TBから、8月31日に約470.8 GB、9月1日に約402.8 GB、9月2日のlive listingで約333.0 GBまで減少した。結果出力IAM修正後の日次 VACUUM は8月27日から9月2日まで連続で成功している。

9月の S3 UnblendedCost は **約$3（想定レンジ $2〜4）** と予測する。Cost Explorer の forecast は `$2.978098`。8月と同じ平均使用量を単純に30日換算した `$21.70` は、8月後半の VACUUM と900秒バッファ化による構造変化を反映しないため採用しない。

予測の前提は、日次 VACUUM が継続して成功し、旧60秒周期で作られた大容量metadataが14日の保持期間外へ抜けることである。VACUUMが停止して現在の約333 GBが1か月維持されるだけでも、ストレージとリクエストを合わせて約$9以上になるため、実行状態を継続監視する。

旧60秒周期の大容量metadataは、最終生成日（8月22日 UTC）から14日経過後の **2026-09-06〜2026-09-07の日次VACUUMで削除される見込み**。次回確認日は削除日ではなく、S3日次メトリクスとCost Explorerの反映を1〜2日待った **2026-09-10** とする。確認項目は次のとおり。

1. 9月3日〜9月9日の日次 VACUUM が全て `SUCCEEDED` であること
2. `iceberg/logs/metadata/` の容量・object数・current snapshot数
3. `AWS/S3 BucketSizeBytes` が定常値まで低下していること
4. 9月の S3 forecast を再取得し、$2〜4の範囲に収まること

9月の確定に近い請求額は、Cost Explorerの反映を待って **2026-10-03以降** に再確認する。

### メモリの判断基準

Fluent Bit 自体の RSS は 30〜60MB 程度（AWS の目安予約は 100〜250MB）。512MB に squid + forwarder (tsnet ~50-100MB) + ADOT (~70-150MB) が既に同居しているため、無条件に増やさず実測で決める。

1. デプロイ前に `AWS/ECS MemoryUtilization` (ClusterName=tidb-proxy, ServiceName=tidb-proxy) の直近 7 日の Maximum を確認
2. **60% 未満 (≈300MB)** → `512` 据え置き。Firehose 出力に `Retry_Limit 2` を設定済みで、Firehose 長時間障害時もチャンクを溜め込まず破棄する（FireLens 自動生成の INPUT には `mem_buf_limit` を注入できないため、メモリ上限はこちらで担保）
3. **60% 以上** → `1024` に増量
4. デプロイ後 1〜2 日観察し、80% 超が出るようなら `1024` に引き上げ（OOM は task ごと再起動 = dev/prd 両方のブログ DB 経路が 1 分程度切れる）

## IaC 構成

責任分界は 2026-06-29 タスクの方針を踏襲（CDK = インフラのスキャフォールド、ecspresso = task/service）。

| 層                      | ツール    | 管理対象                                                                    |
| ----------------------- | --------- | --------------------------------------------------------------------------- |
| ログ基盤インフラ        | CDK       | S3 バケット / Glue DB・Iceberg テーブル / Firehose / Athena WorkGroup / IAM |
| Fluent Bit 設定         | CDK       | `apps/tidb-proxy/firelens/extra.conf` を `BucketDeployment` で S3 に同期    |
| log-router コンテナ定義 | ecspresso | `ecs-task-def.jsonnet` (firelensConfiguration / environment)                |

### CDK 側 (`iac/aws/lib/analytics/`)

`st-tidb-proxy-logs` スタック（dev / prd 共用なので stage prefix なし、`st-tidb-proxy` と同じ流儀）。

- **S3 バケット** `tidb-proxy-logs-<account>`: プレフィックスで用途分離
  - `iceberg/` — テーブル本体。**ライフサイクルルールを設定しない**（Iceberg のマニフェストが参照するファイルを S3 側で blind に消すとメタデータ整合性が壊れるため。データ削減が必要になったら Athena の `OPTIMIZE` / `VACUUM` を先に実行してから検討する）
  - `firehose-errors/` — Firehose 配信失敗レコード。30 日で expire
  - `athena-results/` — Athena クエリ結果。7 日で expire
  - `firelens-config/` — Fluent Bit 設定。`BucketDeployment` で git と同期
  - `autoDeleteObjects: true` のため **`cdk destroy` でログ資産ごと消える**（既存 ECR / LogGroup と同じ割り切り）
- **Glue**: `CfnDatabase` (`tidb_proxy_logs`) + `CfnTable` の `openTableFormatInput.icebergInput` (metadataOperation: CREATE) で Iceberg テーブル `logs` を作成
  - `ts` カラムは **string (ISO8601)**。Firehose の JSON → Iceberg `timestamp` 型変換のフォーマット要求に確証が持てないため、変換の失敗余地がない string で開始。Athena では `from_iso8601_timestamp(ts)` で時刻演算する
  - パーティションなしで開始（string 列に `day` transform が適用できないため。量が増えたら `log_type` の identity パーティション等を検討）
- **Firehose** `tidb-proxy-logs`: DirectPut、`appendOnly: true`、buffering 60s/64MB、失敗レコードのみ `firehose-errors/` へ (`s3BackupMode: FailedDataOnly`)
- **Athena WorkGroup** `tidb-proxy-logs`: engine v3、結果出力 `athena-results/`
- **Athena Named Queries**: よく使う3本を `CfnNamedQuery` で登録 (`recent-activity` / `destination-summary-7d` / `denied-or-error-access`)。ECS ヘルスチェック (127.0.0.1 から30秒ごとの `nc -z`) が squid_access のノイズ行になるため、`client_ip` での除外を基本形にしている
- **タスクロールへの後付け権限**: `st-tidb-proxy` の SSM 出力 (`/tidb-proxy/proxy/task-role`) から `Role.fromRoleArn(..., { mutable: true })` でインポートし、`firehose:PutRecordBatch` / `s3:GetObject` (firelens-config) / `logs:CreateLogStream・PutLogEvents` を付与。`blog-api-construct.ts` が proxy SG に `addIngressRule` するのと同型のパターンで、稼働中の `st-tidb-proxy` は変更しない
- **SSM 出力**: `/tidb-proxy/logs/delivery-stream-name`, `/tidb-proxy/logs/firelens-config-s3-arn-prefix` (ecspresso が参照)

### CD (`.github/workflows/deploy.yaml`)

- `st-tidb-proxy-logs` を Deploy ワークフローの stack 選択肢と `all` の実行順（st-tidb-proxy → st-tidb-proxy-logs → main）に追加。preview / main への push でも自動デプロイされ、FireLens 設定の S3 同期もここで走る
- デプロイロール (`deploy-role-stack.ts`) に `glue:*` / `firehose:*` / `athena:*` を追加（既存の service wildcard と同じ流儀）。**この権限が入る前の環境では deploy-role の再デプロイが先に必要**
- workflow_dispatch はデフォルトブランチにワークフローが登録されていれば `--ref <PRブランチ>` で PR の内容のまま実行できるため、マージ前の検証デプロイも可能

### ecspresso 側 (`iac/aws/ecspresso/tidb-proxy/`)

- `tidb-proxy` コンテナ: `logConfiguration` を `awsfirelens` に変更、`dependsOn: [{log-router, START}]`
- `log-router` コンテナ追加: `aws-for-fluent-bit:init-2.34.3`（stable 系列、arm64 対応確認済み）、`firelensConfiguration: { type: 'fluentbit' }`、環境変数 `aws_fluent_bit_init_s3_1` / `_2` に extra.conf / parsers.conf の S3 ARN。log-router 自身のログは awslogs で `/ecs/tidb-proxy` へ
- `otel-collector`: 無変更

### Fluent Bit 設定 (`apps/tidb-proxy/firelens/extra.conf`)

- FireLens が生成する INPUT (tag `tidb-proxy-firelens-*`) を受け、`log` キーを JSON パース → `rewrite_tag` で `$level` により `cwlogs.*` / `firehose.*` に分岐
- パース不能・level 不明の行はデフォルトタグのまま CloudWatch Logs へフォールバック
- **設定変更時は S3 更新だけでは反映されない**。init プロセスはコンテナ起動時に一度だけ設定を取得するため、`cdk deploy st-tidb-proxy-logs` 後に `aws ecs update-service --cluster tidb-proxy --service tidb-proxy --force-new-deployment` が必要（task def が変わらないため ecspresso diff でも検知されない）

## 要検証事項と結果

| 項目                                          | 結果                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| squid の JSON logformat                       | **検証済み**。alpine 3.24 (squid 7.5) の Docker コンテナで `squid -k parse` + 実 CONNECT リクエストを流し、`%{...}tg` の ISO8601 時刻と `%"` エスケープ（User-Agent 内の `"`）が valid JSON になることを確認                                                                                                                                                                                   |
| aws-for-fluent-bit init タグの ARM64 対応     | **検証済み**。`init-2.34.3`（stable 系列）が amd64/arm64 のマルチアーキで存在することを `docker manifest inspect` で確認し、このタグに pin                                                                                                                                                                                                                                                     |
| Fluent Bit 設定の構文                         | **検証済み**。`aws-for-fluent-bit:stable` (Fluent Bit 1.9) の `--dry-run` で configuration test successful                                                                                                                                                                                                                                                                                     |
| Glue CfnTable の Iceberg テーブル作成方法     | **実デプロイで確定**。`TableInput` は CFN 必須のため、メタデータ (name / columns / location) は全て `TableInput` 側に書き、`IcebergInput` は `MetadataOperation: CREATE` + `Version` のみとする。`icebergTableInput` (ネイティブスキーマ形式) を `TableInput` と併用すると Glue が "Table metadata is expected only via TableInput or via IcebergTableInputProperties" で CREATE_FAILED になる |
| Firehose→Iceberg でスキーマ外フィールドの挙動 | `record_modifier` の `Allowlist_key` でスキーマ列だけに絞る事前除去を実装済み。デプロイ後に firehose-errors/ が空であることを確認する                                                                                                                                                                                                                                                          |

## タスク分解

1. 設計ドキュメント作成（本ドキュメント）
2. forwarder の slog JSON 化 (`apps/tidb-proxy/cmd/forwarder/`)
3. squid.conf の JSON logformat 化
4. Fluent Bit `extra.conf` 作成
5. CDK `st-tidb-proxy-logs` スタック実装 + cdk-nag / テスト
6. ecspresso task def への log-router 追加
7. `01_development.md` へのデプロイ / 確認手順追記
8. デプロイ（メモリ実測 → cdk deploy → イメージ push → ecspresso deploy）と E2E 検証
