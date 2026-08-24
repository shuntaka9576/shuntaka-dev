<!-- cspell:ignore UnblendedCost TBLPROPERTIES trino -->

# tidb-proxy Iceberg メタデータによる S3 高額化の調査と対応

- 起票日: 2026-08-23
- 対象環境: dev / prd 共用ログ基盤
- 対象: `tidb-proxy-logs-<account>` / Glue `tidb_proxy_logs.logs`
- ステータス: snapshot 保持期間は14日で適用済み、手動VACUUMは9回目で完了。初回定期実行のIAM不足をCDKで修正済み（デプロイ・再実行確認待ち）
- 関連タスク: [tidb-proxy: ログを FireLens で振り分けて S3/Iceberg + Athena で検索可能にする](../2026-07-10-tidb-proxy-log-iceberg/index.md)
- 関連実装: `iac/aws/lib/analytics/tidb-proxy-log-analytics-construct.ts`

## 結論

S3 高額化の原因はログデータ本体ではなく、Amazon Data Firehose が約 60 秒ごとに作成する Apache Iceberg の snapshot と metadata JSON である。

2026-08-23 の調査時点で、実ログデータは約 293 MiB しかないのに対し、`iceberg/logs/metadata/` は約 1.54 TiB まで増えていた。現在の metadata JSON は 58,433 件の snapshot 履歴を内包して約 57.8 MB あり、コミットのたびに履歴全体を含む新しい metadata JSON が作成される。古い snapshot を `VACUUM` していないため、メタデータ総量がほぼ二次関数的に増加している。

`iceberg/` に S3 Lifecycle の有効期限を直接設定する対応は行わない。Iceberg が参照中のファイルを S3 側だけで削除するとテーブルの整合性を壊すため、Athena の `VACUUM` で snapshot expiration と orphan file removal を行う。

## 発見経緯

Cost Explorer で S3 の月次コストを確認したところ、2026 年 7 月から増加し、8 月に加速していた。

| 期間                   | S3 UnblendedCost |
| ---------------------- | ---------------: |
| 2026-05                |        $0.010173 |
| 2026-06                |        $0.010388 |
| 2026-07                |        $2.689779 |
| 2026-08-01〜2026-08-23 |       $15.291189 |

8 月分を Usage Type で分解すると、東京リージョンの Standard Storage が大半を占めていた。

| Usage Type                  |       費用 |
| --------------------------- | ---------: |
| `APN1-TimedStorage-ByteHrs` | $14.568212 |
| `APN1-Requests-Tier1`       |  $0.643599 |
| `APN1-Requests-Tier2`       |  $0.078662 |
| その他                      |    ほぼ $0 |

データ転送ではなく、保存容量と頻繁な PUT / multipart upload が原因である。

## バケット別調査

CloudWatch の `AWS/S3` `BucketSizeBytes` を全バケットについて確認したところ、`tidb-proxy-logs-<account>` だけが約 1.52 TiB と突出していた。次点の CDK assets バケットは約 307 MiB だった。

`tidb-proxy-logs-<account>` の live object listing を prefix 別に集計した結果は次のとおり。

| Prefix                   | Object 数 |              合計サイズ |     構成比 |
| ------------------------ | --------: | ----------------------: | ---------: |
| `iceberg/logs/data/`     |    58,533 |       306,764,940 bytes |  約 0.018% |
| `iceberg/logs/metadata/` |   175,884 | 1,689,739,952,214 bytes | 約 99.982% |

CloudWatch の値と live listing の差は、日次メトリクスの反映時刻と、調査中も継続している書き込みによる。

## メタデータ増加の仕組み

Firehose の Iceberg destination は次の設定になっている。

```typescript
bufferingHints: {
  intervalInSeconds: 60,
  sizeInMBs: 64,
},
```

ログ量が 64 MiB に届かないため、実際には約 60 秒ごとに配送・コミットされる。調査時点の Glue `metadata_location` は version 58,433 を指しており、metadata JSON の内容は次の状態だった。

```json
{
  "snapshots": 58433,
  "snapshot_log": 58433,
  "metadata_log": 100
}
```

metadata JSON のサイズ推移から、snapshot 数に比例してファイル自体が増えていることも確認した。

| Version | 更新日時 (UTC)   | metadata JSON サイズ |
| ------: | ---------------- | -------------------: |
|  10,000 | 2026-07-18 07:00 |          9,876,164 B |
|  30,000 | 2026-08-02 00:18 |         29,657,258 B |
|  50,000 | 2026-08-16 16:59 |         49,450,792 B |
|  58,430 | 2026-08-22 20:49 |         57,800,795 B |

各コミットで snapshot 履歴を含む metadata JSON が新規作成され、過去の metadata JSON も残るため、概ね次の増え方になる。

```text
1 commit あたりの metadata サイズ: O(snapshot 数)
metadata 全体の累積サイズ:          O(snapshot 数²)
```

実測でも、バケット容量は 2026-08-10 の約 779 GiB から 8 月 22 日の約 1,518 GiB へ増加している。直近の増加量は 1 日あたり約 50〜77 GiB で、放置すると月額コストも加速する。

## 現行 Lifecycle の確認

S3 Lifecycle は次の一時 prefix にだけ設定されている。

| Prefix             | 有効期限 |
| ------------------ | -------: |
| `firehose-errors/` |     30日 |
| `athena-results/`  |      7日 |

`iceberg/` に Lifecycle を設定していないこと自体は正しい。問題は、Iceberg 側の snapshot expiration / orphan file removal を一度も実施していないことである。

## 対応方針

### 1. 緊急対応: Athena VACUUM

Athena engine version 3 の `VACUUM` を使用する。`VACUUM` は snapshot expiration と orphan file removal をトランザクションとして実行し、到達不能になった metadata / data file を削除する。

実行前に次を確認する。

- 過去 snapshot への time travel が不要であること
- Athena WorkGroup の実行ロールに対象 prefix の `s3:DeleteObject` があること
- Glue の `metadata_location` と直近の snapshot 数を記録すること
- 削除対象を狭めたい場合は、先に保持期間と最低 snapshot 数を明示すること

time travel 用の snapshot 保持期間は **14 日**とする。ログデータ自体の保持期間ではなく、過去 snapshot を参照できる期間である。

既存テーブルへの設定は CDK の `CfnTable.Parameters` ではなく、Athena 経由で Iceberg metadata に反映する。Athena 用の汎用 migration 基盤は新設せず、冪等な番号付き SQL を Git で差分管理する。

| 用途                     | 管理方法                                                       |
| ------------------------ | -------------------------------------------------------------- |
| snapshot 保持期間の設定  | `iac/aws/sql/tidb-proxy-logs/001-set-vacuum-retention-14d.sql` |
| 手動・定期 VACUUM        | `iac/aws/sql/tidb-proxy-logs/vacuum.sql`                       |
| 初回適用と前後比較       | `scripts/maintain-tidb-proxy-iceberg.sh`                       |
| 日次 VACUUM の起動基盤   | EventBridge Scheduler + Lambda を CDK で管理（未実装）         |
| Firehose buffer interval | `TidbProxyLogAnalyticsConstruct` を CDK で管理                 |

保持期間の設定:

```sql
ALTER TABLE tidb_proxy_logs.logs SET TBLPROPERTIES (
  'vacuum_max_snapshot_age_seconds' = '1209600',
  'vacuum_min_snapshots_to_keep' = '1',
  'vacuum_max_metadata_files_to_keep' = '100'
);
```

実行:

```sql
VACUUM tidb_proxy_logs.logs;
```

`1209600` 秒は 14 日。Athena のデフォルトは snapshot 最大保持期間 5 日、最低保持数 1、過去 metadata file 100 件である。

### 初回実行手順

AWS SSO 認証済みのリポジトリルートで次を実行する。

```bash
bash scripts/maintain-tidb-proxy-iceberg.sh
```

スクリプトは次の順で処理し、実行結果を標準出力へ残す。

1. 対象 account / region / WorkGroup / database / bucket を表示
2. 実行前の `data/`・`metadata/` の object 数と容量、snapshot 数を表示
3. `001-set-vacuum-retention-14d.sql` を Athena で実行し、完了まで待機
4. `vacuum.sql` を Athena で実行し、完了まで待機
5. 実行後の object 数・容量、snapshot 数を再取得

各 Athena query の `QueryExecutionId`、状態、実行時間、スキャン量、結果出力先も記録する。`FAILED` / `CANCELLED` の場合は理由を表示して停止し、後続処理を実行しない。

### VACUUM の実行コスト

初回 `VACUUM` の費用は、削減できるストレージ費用と比べて十分小さい見込み。

| 課金要素                | 今回の扱い                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| Athena compute          | `VACUUM` はコンピュート料金なし                                                          |
| S3 DELETE               | 無料                                                                                     |
| S3 LIST / GET など      | 課金対象。約 17.6 万 metadata objects の規模では、数セント〜多くても数十セント程度と推定 |
| 前後比較の S3 API / GET | 同様に少額。current metadata JSON（調査時約 57.8 MB）の取得と prefix listing を実行      |

正確な S3 API 呼び出し回数は Athena の内部実装に依存するため、上記は概算である。AWS 公式ドキュメントでも、Athena `VACUUM` 自体にはコンピュート料金がかからず、処理中の S3 API リクエストには料金が発生すると説明されている。

現在は約 1.5 TiB を S3 Standard に保持し、さらに 1 日あたり約 50〜77 GiB 増加している。初回 `VACUUM` の一時的なリクエスト費用より、実行を遅らせてストレージを保持し続ける費用の方が大きい。

費用より注意すべき点は次のとおり。

- 初回は約 17.6 万 metadata objects を処理するため、完了まで時間がかかる可能性がある
- 稼働中の Firehose と Iceberg metadata 更新が競合し、Athena query が失敗する可能性がある
- `s3:DeleteObject` が不足している場合、`VACUUM` query が成功してもファイルが削除されない場合がある
- 実行スクリプトは `FAILED` / `CANCELLED` を検出した時点で停止し、QueryExecutionId と失敗理由を残す

`VACUUM` 後は次を確認する。

1. Athena で `SELECT` が成功する
2. Glue の `metadata_location` が存在する
3. `iceberg/logs/metadata/` の object 数と容量が減る
4. 翌日の `BucketSizeBytes` が減る
5. Firehose の配信エラーが増えていない

### 2. 再発防止: バッファ間隔の延長

`bufferingHints.intervalInSeconds` を 60 秒から 900 秒へ延長する。Firehose の値は hint だが、低トラフィック時のコミット頻度と S3 書き込み回数を最大で約 15 分の 1 に抑えられる。2026-08-23 に CDK 実装済みだが、まだ AWS 環境へはデプロイしていない。

```diff
 bufferingHints: {
-  intervalInSeconds: 60,
+  intervalInSeconds: 900,
   sizeInMBs: 64,
 },
```

トレードオフとして、Athena から検索可能になるまで最大約 15 分の遅延を許容する。障害系ログは従来どおり CloudWatch Logs に送るため、INFO 系ログだけの遅延である。

### 3. 再発防止: VACUUM の定期実行

バッファ間隔を延ばしても snapshot は増え続けるため、定期 `VACUUM` が必要。2026-08-23 に日次実行基盤を CDK へ追加し、2026-08-24 に手動 `VACUUM` の正常完了と前後差分を確認できたためスケジュールを有効化した。

```text
EventBridge Rule（毎日 03:00 JST、ENABLED）
  └─ Step Functions Standard
       └─ Athena StartQueryExecution.sync
            └─ VACUUM tidb_proxy_logs.logs
```

実装内容:

- `getLogAnalyticsConfig().vacuum.scheduleEnabled` は `true`
- EventBridge Rule の CloudFormation `State` は `ENABLED`
- Lambda の最大実行時間 15 分を避けるため、Step Functions の Athena `.sync` integration で query の成功・失敗まで待機
- State Machine と Athena task の timeout は 5 時間。Athena 側の DML timeout quota は 240 分へ引き上げ済み
- State Machine の実行ログは CloudWatch Logs に 14 日保持し、X-Ray tracing を有効化
- VACUUM 用ロールには専用 S3 bucket に対する `s3:DeleteObject` と、`iceberg/logs/metadata/*` に限定した `s3:PutObject` を付与
- EventBridge からの再試行は 0 回。失敗を隠して重複実行しない

日次実行は毎日 03:00 JST に開始する。Athena queryの完了までStep Functions Standardの `.sync` integrationで待機するが、Standard Workflowは実行時間ではなくstate transition数で課金されるため、40分前後の待機時間による実行時間課金は発生しない。

#### synth / diff / deploy

リポジトリルートから実行する。

```bash
cd iac/aws
bunx dotenv -- cdk synth st-tidb-proxy-logs -c stageName=dev
bunx dotenv -- cdk diff st-tidb-proxy-logs -c stageName=dev
bunx dotenv -- cdk deploy st-tidb-proxy-logs -c stageName=dev
```

デプロイ後、定期実行が有効であることを確認する。

#### 初回定期実行の失敗とIAM修正（2026-08-25）

初回の定期実行は EventBridge から予定どおり起動したが、Athena が約2.5秒で失敗した。タイムアウトではない。

| 項目             | 結果                                   |
| ---------------- | -------------------------------------- |
| Step Functions   | `FAILED`                               |
| 開始             | 2026-08-25 03:00:05 JST                |
| 終了             | 2026-08-25 03:01:02 JST                |
| QueryExecutionId | `60fa4a8a-330e-45a5-ba8b-cae44299d690` |
| Athena実行時間   | 2,553 ms                               |
| Data scanned     | 0 bytes                                |
| Athena error     | `GENERIC_INTERNAL_ERROR`               |

<details>
<summary>Athenaエラー</summary>

```text
GENERIC_INTERNAL_ERROR: Failed to write json to file: io.trino.filesystem.s3.S3OutputFile@345029b0
```

</details>

手動VACUUMは成功していた一方、定期実行のStep Functionsロールでは、Athena結果保存先の `athena-results/vacuum/*` にしか `s3:PutObject` が付与されていなかった。VACUUMは到達不能ファイルの削除だけでなく、transaction commit時に新しいIceberg metadata JSONを `iceberg/logs/metadata/` へ書き込むため、ここへの権限不足が原因だった。

対応として、Step Functionsロールへ `iceberg/logs/metadata/*` に限定した `s3:PutObject` をCDKで追加した。削除対象はmetadataとdataの両方になり得るため、既存のログ専用bucket全体への `s3:DeleteObject` は維持する。CDKテストではmetadata prefixへのPutObjectを明示的に検証し、権限の欠落を再発防止する。

```bash
aws events describe-rule \
  --name tidb-proxy-logs-vacuum \
  --region ap-northeast-1 \
  --query '{State:State,ScheduleExpression:ScheduleExpression}'
```

期待値:

```json
{
  "State": "ENABLED",
  "ScheduleExpression": "cron(0 18 * * ? *)"
}
```

`iac/aws/lib/config.ts` の `scheduleEnabled: true` を正とする。障害対応などで一時停止する場合もコンソールや `aws events disable-rule` だけで変更せず、CDKの設定を変更してdeployし、次回deployで意図せず再有効化されないようにする。

### 4. 中長期対応: Iceberg を使う必要性の再評価

このログは append-only で更新・削除を行わない。snapshot / time travel が不要なら、日付 partition 付き Parquet を通常の S3 prefix へ配送し、Glue 外部テーブルで検索する方が単純である。

| 案                               | 長所                                     | 短所                           |
| -------------------------------- | ---------------------------------------- | ------------------------------ |
| Iceberg + 定期 VACUUM            | 現行構成を維持できる                     | テーブルメンテナンスが必須     |
| 通常 S3 + 日付 partition Parquet | snapshot metadata がなく、ログ用途に適合 | 配送・テーブル定義の変更が必要 |

## 対応時に行わないこと

- `iceberg/logs/metadata/` を `aws s3 rm --recursive` で直接削除しない
- `iceberg/` に一律の S3 Lifecycle expiration を設定しない
- Glue の `metadata_location` が参照するファイルを手動削除しない
- `VACUUM` の完了確認前に追加の削除操作を行わない

## 再調査コマンド

以下は読み取り専用。期間は調査日に合わせて変更する。

### Cost Explorer

```bash
aws ce get-cost-and-usage \
  --time-period Start=2026-05-01,End=2026-08-24 \
  --granularity MONTHLY \
  --metrics UnblendedCost \
  --filter '{"Dimensions":{"Key":"SERVICE","Values":["Amazon Simple Storage Service"]}}'

aws ce get-cost-and-usage \
  --time-period Start=2026-08-01,End=2026-08-24 \
  --granularity MONTHLY \
  --metrics UnblendedCost \
  --filter '{"Dimensions":{"Key":"SERVICE","Values":["Amazon Simple Storage Service"]}}' \
  --group-by Type=DIMENSION,Key=USAGE_TYPE
```

### Prefix ごとの object 数・容量

```bash
BUCKET="tidb-proxy-logs-$(aws sts get-caller-identity --query Account --output text)"

aws s3api list-objects-v2 \
  --bucket "${BUCKET}" \
  --prefix iceberg/logs/data/ \
  --query '[length(Contents),sum(Contents[].Size)]'

aws s3api list-objects-v2 \
  --bucket "${BUCKET}" \
  --prefix iceberg/logs/metadata/ \
  --query '[length(Contents),sum(Contents[].Size)]'
```

### 現在の metadata 状態

```bash
METADATA_URI=$(aws glue get-table \
  --database-name tidb_proxy_logs \
  --name logs \
  --query 'Table.Parameters.metadata_location' \
  --output text)

aws s3 cp "${METADATA_URI}" - --no-progress |
  jq '{
    snapshots: (.snapshots | length),
    snapshot_log: (."snapshot-log" | length),
    metadata_log: (."metadata-log" | length),
    last_updated_ms: ."last-updated-ms"
  }'
```

### バケット容量の推移

```bash
aws cloudwatch get-metric-statistics \
  --namespace AWS/S3 \
  --metric-name BucketSizeBytes \
  --dimensions \
    Name=BucketName,Value="${BUCKET}" \
    Name=StorageType,Value=StandardStorage \
  --start-time 2026-08-10T00:00:00Z \
  --end-time 2026-08-24T00:00:00Z \
  --period 86400 \
  --statistics Average \
  --region ap-northeast-1
```

## 参考資料

- [VACUUM - Amazon Athena](https://docs.aws.amazon.com/athena/latest/ug/vacuum-statement.html)
- [Optimize Iceberg tables - Amazon Athena](https://docs.aws.amazon.com/athena/latest/ug/querying-iceberg-data-optimization.html)
- [Set up the Firehose stream - Apache Iceberg Tables](https://docs.aws.amazon.com/firehose/latest/dev/apache-iceberg-stream.html)

## 初回適用結果

2026-08-23 06:11〜06:42 JST に `scripts/maintain-tidb-proxy-iceberg.sh` を実行した。

<details>
<summary>初回実行のターミナルログ（クリックして展開）</summary>

公開用に AWS アカウント ID のみ `<account>` へ置換している。その他は実行時の標準出力・標準エラーをそのまま記録した。

```console
== Target ==
account_id=<account>
region=ap-northeast-1
work_group=tidb-proxy-logs
database=tidb_proxy_logs
bucket=tidb-proxy-logs-<account>

== Before: data ==
{
    "Objects": 58551,
    "Bytes": 306859273
}
== Before: metadata ==
{
    "Objects": 175938,
    "Bytes": 1690780791917
}
== Before: current metadata ==
metadata_location=s3://tidb-proxy-logs-<account>/iceberg/logs/metadata/58449-ef0c09c8-fbba-4a8b-aa27-82084f5a2887.metadata.json
{
  "snapshots": 58449,
  "snapshot_log": 58449,
  "metadata_log": 100,
  "last_updated_ms": 1787433026084
}

== Apply 14-day snapshot retention ==
query_execution_id=b529cfc0-5abf-496a-a726-9a5ca4e00da8
state=RUNNING
state=SUCCEEDED
{
  "query_execution_id": "b529cfc0-5abf-496a-a726-9a5ca4e00da8",
  "state": "SUCCEEDED",
  "submission_datetime": "2026-08-23T06:11:19.775000+09:00",
  "completion_datetime": "2026-08-23T06:11:22.066000+09:00",
  "engine_execution_ms": 2072,
  "data_scanned_bytes": 0,
  "output_location": "s3://tidb-proxy-logs-<account>/athena-results/b529cfc0-5abf-496a-a726-9a5ca4e00da8.txt"
}

== Vacuum Iceberg table ==
query_execution_id=64c8fe82-ba90-46e2-b5b2-b8ae7692e58a
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=FAILED
Query timeout
```

</details>

### 実行前

| Prefix                   | Object 数 |              合計サイズ |
| ------------------------ | --------: | ----------------------: |
| `iceberg/logs/data/`     |    58,551 |       306,859,273 bytes |
| `iceberg/logs/metadata/` |   175,938 | 1,690,780,791,917 bytes |

実行直前の current metadata は version 58,449。snapshot と snapshot log はともに 58,449 件、metadata log は 100 件だった。

### 14 日保持設定

`001-set-vacuum-retention-14d.sql` は成功した。

| 項目             | 結果                                   |
| ---------------- | -------------------------------------- |
| QueryExecutionId | `b529cfc0-5abf-496a-a726-9a5ca4e00da8` |
| 状態             | `SUCCEEDED`                            |
| 開始             | 2026-08-23 06:11:19 JST                |
| 完了             | 2026-08-23 06:11:22 JST                |
| Engine execution | 2,072 ms                               |
| Data scanned     | 0 bytes                                |

これにより、time travel 用 snapshot の保持期間 14 日、最低保持数 1、過去 metadata file 100 件の設定は Iceberg metadata に反映された。

### 初回 VACUUM

`vacuum.sql` は約 30 分間 `RUNNING` の後、`Query timeout` で失敗した。

| 項目             | 結果                                   |
| ---------------- | -------------------------------------- |
| QueryExecutionId | `64c8fe82-ba90-46e2-b5b2-b8ae7692e58a` |
| 状態             | `FAILED`                               |
| 理由             | `Query timeout`                        |

SQL 構文エラーではなく、大量の snapshot / metadata objects を処理中に Athena の実行時間上限へ到達した。東京リージョンの DML query timeout quota は調査時点で 30 分だった。スクリプトは `set -e` と失敗状態の検出により、この時点で停止した。

スクリプト内の「実行後」計測は未実施となったため、失敗後に読み取り専用コマンドで再計測した。

| 項目                 |            実行前 |        timeout 後 | 差分           |
| -------------------- | ----------------: | ----------------: | -------------- |
| data objects         |            58,551 |            58,604 | +53            |
| data bytes           |       306,859,273 |       307,137,080 | +277,807       |
| metadata objects     |           175,938 |           176,099 | +161           |
| metadata bytes       | 1,690,780,791,917 | 1,691,864,048,777 | +1,083,256,860 |
| current snapshots    |            58,449 |            19,170 | -39,279        |
| current snapshot log |            58,449 |            19,170 | -39,279        |
| current metadata log |               100 |               100 | 変更なし       |

current metadata の properties も次の値になっていた。

```json
{
  "history.expire.max-snapshot-age-ms": "1209600000",
  "history.expire.min-snapshots-to-keep": "1",
  "write.metadata.previous-versions-max": "100"
}
```

<details>
<summary>Query timeout 後の再計測ログ（クリックして展開）</summary>

公開用に AWS アカウント ID のみ `<account>` へ置換している。

```console
POST_FAILURE_DATA
{
    "Objects": 58604,
    "Bytes": 307137080
}
POST_FAILURE_METADATA
{
    "Objects": 176099,
    "Bytes": 1691864048777
}
POST_FAILURE_CURRENT
s3://tidb-proxy-logs-<account>/iceberg/logs/metadata/58504-605709f4-ea46-41ca-8c70-b25f05945e45.metadata.json
{
  "snapshots": 19170,
  "snapshot_log": 19170,
  "metadata_log": 100,
  "properties": {
    "history.expire.max-snapshot-age-ms": "1209600000",
    "write.metadata.previous-versions-max": "100",
    "write.parquet.compression-codec": "zstd",
    "history.expire.min-snapshots-to-keep": "1"
  }
}
```

</details>

この結果から、14 日より古い snapshot の expiration と新しい metadata への commit は成功している。一方、過去 metadata objects の物理削除は完了しておらず、Firehose の継続書き込み分も加わって metadata 容量は約 1.08 GB 増加した。`VACUUM` は snapshot expiration 後の orphan file removal 中に timeout したと判断する。

現時点では容量削減を確認できていない。再実行方法を決定するまでは、Iceberg prefix の手動削除を行わない。

### 2 回目の VACUUM

初回 `VACUUM` により current snapshots は 58,449 件から 19,170 件まで削減済み。2 回目は snapshot expiration 後の状態から開始できるため、まず現行の DML query timeout 30 分のまま再実行する。

先に timeout quota を引き上げる案もあるが、初回で snapshot 数が約 3 分の 1 まで減っており、2 回目は初回より少ない処理量で完了する可能性がある。このため、まず 30 分上限のまま再実行して挙動を見ることにした。ただし、約 17.6 万個の metadata objects に対する orphan file removal が引き続きボトルネックになる可能性があり、30 分以内の完了を保証する判断ではない。

AWS SSO 認証済みのリポジトリルートで次を実行する。

```bash
bash scripts/maintain-tidb-proxy-iceberg.sh
```

14 日保持の `ALTER TABLE SET TBLPROPERTIES` は同じ値で再適用しても問題ない。スクリプトを再利用し、実行前後の object 数・容量・snapshot 数を同じ形式で記録する。

#### 2 回目の実行結果

2026-08-23 07:15〜07:45 JST に再実行したが、初回と同じく約 30 分で `Query timeout` になった。

<details>
<summary>2回目のターミナルログ（クリックして展開）</summary>

公開用に AWS アカウント ID のみ `<account>` へ置換している。ポーリング中の `state=RUNNING` も省略していない。

```console
== Target ==
account_id=<account>
region=ap-northeast-1
work_group=tidb-proxy-logs
database=tidb_proxy_logs
bucket=tidb-proxy-logs-<account>

== Before: data ==
{
    "Objects": 58614,
    "Bytes": 307189470
}
== Before: metadata ==
{
    "Objects": 176130,
    "Bytes": 1692057595448
}
== Before: current metadata ==
metadata_location=s3://tidb-proxy-logs-<account>/iceberg/logs/metadata/58514-2828373f-46ea-41f7-8923-ae42132e3440.metadata.json
{
  "snapshots": 19180,
  "snapshot_log": 19180,
  "metadata_log": 100,
  "last_updated_ms": 1787436868021
}

== Apply 14-day snapshot retention ==
query_execution_id=91fd5d6a-74fb-452f-b515-dd3178689486
state=RUNNING
state=SUCCEEDED
{
  "query_execution_id": "91fd5d6a-74fb-452f-b515-dd3178689486",
  "state": "SUCCEEDED",
  "submission_datetime": "2026-08-23T07:15:22.697000+09:00",
  "completion_datetime": "2026-08-23T07:15:23.306000+09:00",
  "engine_execution_ms": 431,
  "data_scanned_bytes": 0,
  "output_location": "s3://tidb-proxy-logs-<account>/athena-results/91fd5d6a-74fb-452f-b515-dd3178689486.txt"
}

== Vacuum Iceberg table ==
query_execution_id=0cf73a44-0b78-4fd7-810c-ac9c4484c628
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=RUNNING
state=FAILED
Query timeout
```

</details>

<details>
<summary>初回・2回目の Athena 実行統計（クリックして展開）</summary>

```json
{
  "id": "64c8fe82-ba90-46e2-b5b2-b8ae7692e58a",
  "status": {
    "State": "FAILED",
    "StateChangeReason": "Query timeout",
    "SubmissionDateTime": "2026-08-23T06:11:22.820000+09:00",
    "CompletionDateTime": "2026-08-23T06:41:58.705000+09:00",
    "AthenaError": {
      "ErrorCategory": 1,
      "ErrorType": 206,
      "Retryable": false,
      "ErrorMessage": "Query timeout"
    }
  },
  "statistics": {
    "EngineExecutionTimeInMillis": 1797318,
    "DataScannedInBytes": 0,
    "TotalExecutionTimeInMillis": 1835885,
    "QueryQueueTimeInMillis": 91,
    "ServicePreProcessingTimeInMillis": 46,
    "ServiceProcessingTimeInMillis": 38430,
    "ResultReuseInformation": {
      "ReusedPreviousResult": false
    }
  },
  "engine_version": {
    "SelectedEngineVersion": "Athena engine version 3",
    "EffectiveEngineVersion": "Athena engine version 3"
  }
}
{
  "id": "0cf73a44-0b78-4fd7-810c-ac9c4484c628",
  "status": {
    "State": "FAILED",
    "StateChangeReason": "Query timeout",
    "SubmissionDateTime": "2026-08-23T07:15:25.727000+09:00",
    "CompletionDateTime": "2026-08-23T07:45:32.141000+09:00",
    "AthenaError": {
      "ErrorCategory": 1,
      "ErrorType": 206,
      "Retryable": false,
      "ErrorMessage": "Query timeout"
    }
  },
  "statistics": {
    "EngineExecutionTimeInMillis": 1771820,
    "DataScannedInBytes": 0,
    "TotalExecutionTimeInMillis": 1806414,
    "QueryQueueTimeInMillis": 85,
    "ServicePreProcessingTimeInMillis": 47,
    "ServiceProcessingTimeInMillis": 34462,
    "ResultReuseInformation": {
      "ReusedPreviousResult": false
    }
  },
  "engine_version": {
    "SelectedEngineVersion": "Athena engine version 3",
    "EffectiveEngineVersion": "Athena engine version 3"
  }
}
```

</details>

2 回目の開始前と timeout 後を比較した。

| 項目                     |      2 回目開始前 |        timeout 後 | 差分         |
| ------------------------ | ----------------: | ----------------: | ------------ |
| metadata objects         |           176,130 |           176,233 | +103         |
| metadata bytes           | 1,692,057,595,448 | 1,692,721,833,620 | +664,238,172 |
| current snapshots        |            19,180 |            19,151 | -29          |
| Athena DML timeout quota |             30 分 |             30 分 | 変更なし     |

snapshot 数はほぼ変わらず、metadata objects と容量は Firehose の継続書き込みにより増加した。2 回目でも orphan file removal による物理削除は確認できず、同じ 30 分上限での再試行が完了する可能性は低い。

両方とも query queue は 100 ms 未満、engine execution は約 29.5〜30 分、data scanned は 0 bytes だった。2 回目がキュー待ちや通常の SQL データスキャンで遅延したのではなく、初回と同じ Iceberg メンテナンス処理を実行時間上限まで行っている。初回で 14 日より古い snapshot の expiration は反映済みのため、2 回目に減らせる snapshot はほぼ残っていなかった。一方、orphan file removal が前回の checkpoint から再開された形跡はなく、timeout 後も旧 metadata objects の物理削除は確認できなかった。

#### 3 回目の実行方針

次回は東京リージョンの Athena DML query timeout quota を 30 分から 240 分へ引き上げ、現在値への反映を確認してから再実行する。120 分でも完了する可能性はあるが、2 回連続で 30 分上限へ到達し、物理削除が進んでいないため、再試行回数を減らす目的で公式上限の 240 分を選ぶ。

調査時点の Quota Code は `L-E80DC288` で、quota は調整可能。

```bash
aws service-quotas request-service-quota-increase \
  --service-code athena \
  --quota-code L-E80DC288 \
  --desired-value 240 \
  --region ap-northeast-1
```

quota 申請後は申請状態を確認し、現在値が 240 分になってから `VACUUM` を再実行する。申請直後に即時反映されるとは限らない。

```bash
aws service-quotas list-service-quotas \
  --service-code athena \
  --region ap-northeast-1 \
  --query "Quotas[?QuotaCode=='L-E80DC288'].[QuotaName,Value,QuotaCode,Adjustable]" \
  --output table
```

#### quota 引き上げの実行結果

2026-08-23 に 240 分への引き上げを申請し、同日中に実効 quota への反映を確認した。申請 ID、Support case ID、AWS account ID は公開文書には記録しない。

| 項目                             | 結果                    |
| -------------------------------- | ----------------------- |
| 申請作成                         | 2026-08-23 08:03:21 JST |
| `CASE_OPENED` への更新           | 2026-08-23 08:06:28 JST |
| 30 分を最後に確認                | 2026-08-23 13:51:25 JST |
| 240 分を最初に確認               | 2026-08-23 13:52:26 JST |
| 申請から反映確認まで             | 約 5 時間 49 分         |
| `CASE_OPENED` から反映確認まで   | 約 5 時間 46 分         |
| 反映後の DML query timeout quota | 240 分                  |
| 反映確認時点の申請ステータス     | `CASE_OPENED`           |

監視は 60 秒間隔だったため、実際の反映時刻は **13:51:25 から 13:52:26 JST の間**である。申請作成からの正確な所要時間は 5 時間 48 分 4 秒から 5 時間 49 分 5 秒の範囲で、表では約 5 時間 49 分としている。

申請ステータスは反映確認時点でも `CASE_OPENED` だったが、現在の実効値を取得する次のコマンドでは `240.0` を返した。quota の利用可否は申請ステータスではなく、この実効値で判断する。

```bash
aws service-quotas get-service-quota \
  --service-code athena \
  --quota-code L-E80DC288 \
  --region ap-northeast-1 \
  --query 'Quota.{Value:Value,QuotaName:QuotaName}' \
  --output json
```

```json
{
  "Value": 240.0,
  "QuotaName": "DML query timeout"
}
```

#### 3 回目の VACUUM（240 分 quota 反映後）

実効 quota が 240 分になったことを確認してから、3 回目の `VACUUM` を実行した。今回は timeout ではなく、Athena が 1 回の VACUUM で 20,000 files を削除した時点で、残りを次回の VACUUM で処理するよう要求して終了した。

| 項目             | 結果                                      |
| ---------------- | ----------------------------------------- |
| QueryExecutionId | `21a4730d-66e0-44ac-93c9-8d8e6c1fa898`    |
| 状態             | `FAILED`                                  |
| 理由             | `ICEBERG_VACUUM_MORE_RUNS_NEEDED`         |
| 開始             | 2026-08-23 14:11:22 JST                   |
| 完了             | 2026-08-23 14:52:19 JST                   |
| Engine execution | 2,456,687 ms（約 40 分 57 秒）            |
| Data scanned     | 0 bytes                                   |
| 削除済み files   | 20,000（Athena のエラーメッセージによる） |

<details>
<summary>3 回目の Athena 実行統計</summary>

```json
{
  "status": {
    "State": "FAILED",
    "StateChangeReason": "ICEBERG_VACUUM_MORE_RUNS_NEEDED: Removed 20000 files in this round of vacuum, but there are more files remaining. Please run another VACUUM command to process the remaining files",
    "SubmissionDateTime": "2026-08-23T14:11:22.963000+09:00",
    "CompletionDateTime": "2026-08-23T14:52:19.927000+09:00",
    "AthenaError": {
      "ErrorCategory": 2,
      "ErrorType": 233,
      "Retryable": false,
      "ErrorMessage": "ICEBERG_VACUUM_MORE_RUNS_NEEDED: Removed 20000 files in this round of vacuum, but there are more files remaining. Please run another VACUUM command to process the remaining files"
    }
  },
  "statistics": {
    "EngineExecutionTimeInMillis": 2456687,
    "DataScannedInBytes": 0,
    "TotalExecutionTimeInMillis": 2456964,
    "QueryQueueTimeInMillis": 97,
    "ServicePreProcessingTimeInMillis": 44,
    "QueryPlanningTimeInMillis": 4,
    "ServiceProcessingTimeInMillis": 136,
    "ResultReuseInformation": {
      "ReusedPreviousResult": false
    }
  },
  "engine_version": {
    "SelectedEngineVersion": "Athena engine version 3",
    "EffectiveEngineVersion": "Athena engine version 3"
  }
}
```

</details>

実行前後の S3 と current metadata は次のとおり。

| 項目              |            実行前 |            実行後 | 差分             |
| ----------------- | ----------------: | ----------------: | ---------------- |
| data objects      |            59,009 |            58,973 | -36              |
| data bytes        |       309,260,637 |       309,072,626 | -188,011         |
| metadata objects  |           177,321 |           157,441 | -19,880          |
| metadata bytes    | 1,699,657,790,869 | 1,565,310,916,416 | -134,346,874,453 |
| current snapshots |            19,513 |            19,137 | -376             |

metadata は純減 19,880 objects、約 134.35 GB 削減となり、orphan files の物理削除を初めて確認できた。Athena のメッセージにある削除数 20,000 と純減の差 120 objects は、実行中も Firehose が新しい metadata を書き込み続けている影響を含む。

`Retryable: false` のため AWS SDK による自動 retry の対象ではないが、エラーメッセージは残りを処理するために次の `VACUUM` を実行するよう明示している。したがって、これは quota timeout ではなく、20,000 files 単位で処理を継続するための終了状態として扱う。

#### 4 回目の VACUUM

3 回目と同じく、20,000 files を削除した時点で `ICEBERG_VACUUM_MORE_RUNS_NEEDED` になった。実行時間は約 46 分 16 秒で、240 分の quota timeout には到達していない。

| 項目             | 結果                                      |
| ---------------- | ----------------------------------------- |
| QueryExecutionId | `476973a1-8ef3-47cc-8492-6b71982558cd`    |
| 状態             | `FAILED`                                  |
| 理由             | `ICEBERG_VACUUM_MORE_RUNS_NEEDED`         |
| 開始             | 2026-08-23 16:36:14 JST                   |
| 完了             | 2026-08-23 17:22:29 JST                   |
| Engine execution | 2,775,301 ms（約 46 分 15 秒）            |
| Data scanned     | 0 bytes                                   |
| 削除済み files   | 20,000（Athena のエラーメッセージによる） |

<details>
<summary>4 回目の Athena 実行統計</summary>

```json
{
  "status": {
    "State": "FAILED",
    "StateChangeReason": "ICEBERG_VACUUM_MORE_RUNS_NEEDED: Removed 20000 files in this round of vacuum, but there are more files remaining. Please run another VACUUM command to process the remaining files",
    "SubmissionDateTime": "2026-08-23T16:36:14.093000+09:00",
    "CompletionDateTime": "2026-08-23T17:22:29.653000+09:00",
    "AthenaError": {
      "ErrorCategory": 2,
      "ErrorType": 233,
      "Retryable": false,
      "ErrorMessage": "ICEBERG_VACUUM_MORE_RUNS_NEEDED: Removed 20000 files in this round of vacuum, but there are more files remaining. Please run another VACUUM command to process the remaining files"
    }
  },
  "statistics": {
    "EngineExecutionTimeInMillis": 2775301,
    "DataScannedInBytes": 0,
    "TotalExecutionTimeInMillis": 2775560,
    "QueryQueueTimeInMillis": 95,
    "ServicePreProcessingTimeInMillis": 80,
    "QueryPlanningTimeInMillis": 6,
    "ServiceProcessingTimeInMillis": 84,
    "ResultReuseInformation": {
      "ReusedPreviousResult": false
    }
  },
  "engine_version": {
    "SelectedEngineVersion": "Athena engine version 3",
    "EffectiveEngineVersion": "Athena engine version 3"
  }
}
```

</details>

実行前後の S3 と current metadata は次のとおり。

| 項目              |            実行前 |            実行後 | 差分             |
| ----------------- | ----------------: | ----------------: | ---------------- |
| data objects      |            58,973 |            58,977 | +4               |
| data bytes        |       309,072,626 |       309,094,214 | +21,588          |
| metadata objects  |           157,441 |           137,454 | -19,987          |
| metadata bytes    | 1,565,310,916,416 | 1,192,049,586,860 | -373,261,329,556 |
| current snapshots |            19,137 |            19,005 | -132             |

metadata はさらに純減 19,987 objects、約 373.26 GB 削減となった。3 回目との累計では、40,000 files の削除により metadata が 39,867 objects、約 507.61 GB 純減している。data objects の +4 は実行中の Firehose 配信による変動範囲である。

#### 5 回目の VACUUM

5 回目も20,000 filesを削除した時点で `ICEBERG_VACUUM_MORE_RUNS_NEEDED` になった。実行時間は約42分08秒だった。

| 項目             | 結果                                      |
| ---------------- | ----------------------------------------- |
| QueryExecutionId | `103758fa-bc13-4d97-a191-5669579a2cd0`    |
| 状態             | `FAILED`                                  |
| 理由             | `ICEBERG_VACUUM_MORE_RUNS_NEEDED`         |
| 開始             | 2026-08-23 17:27:36 JST                   |
| 完了             | 2026-08-23 18:09:44 JST                   |
| Engine execution | 2,527,812 ms（約42分08秒）                |
| Data scanned     | 0 bytes                                   |
| 削除済み files   | 20,000（Athena のエラーメッセージによる） |

<details>
<summary>5 回目の Athena 実行統計</summary>

```json
{
  "status": {
    "State": "FAILED",
    "StateChangeReason": "ICEBERG_VACUUM_MORE_RUNS_NEEDED: Removed 20000 files in this round of vacuum, but there are more files remaining. Please run another VACUUM command to process the remaining files",
    "SubmissionDateTime": "2026-08-23T17:27:36.591000+09:00",
    "CompletionDateTime": "2026-08-23T18:09:44.652000+09:00",
    "AthenaError": {
      "ErrorCategory": 2,
      "ErrorType": 233,
      "Retryable": false,
      "ErrorMessage": "ICEBERG_VACUUM_MORE_RUNS_NEEDED: Removed 20000 files in this round of vacuum, but there are more files remaining. Please run another VACUUM command to process the remaining files"
    }
  },
  "statistics": {
    "EngineExecutionTimeInMillis": 2527812,
    "DataScannedInBytes": 0,
    "TotalExecutionTimeInMillis": 2528061,
    "QueryQueueTimeInMillis": 97,
    "ServicePreProcessingTimeInMillis": 54,
    "QueryPlanningTimeInMillis": 4,
    "ServiceProcessingTimeInMillis": 98,
    "ResultReuseInformation": {
      "ReusedPreviousResult": false
    }
  },
  "engine_version": {
    "SelectedEngineVersion": "Athena engine version 3",
    "EffectiveEngineVersion": "Athena engine version 3"
  }
}
```

</details>

実行前後の S3 と current metadata は次のとおり。

| 項目              |            実行前 |          実行後 | 差分             |
| ----------------- | ----------------: | --------------: | ---------------- |
| data objects      |            58,977 |          58,980 | +3               |
| data bytes        |       309,094,214 |     309,110,194 | +15,980          |
| metadata objects  |           137,454 |         117,464 | -19,990          |
| metadata bytes    | 1,192,049,586,860 | 910,000,995,313 | -282,048,591,547 |
| current snapshots |            19,005 |          18,958 | -47              |

metadata は純減 19,990 objects、約282.05 GB削減となった。3〜5回目の累計では60,000 filesの削除によりmetadataが59,857 objects、約789.66 GB純減している。

#### 6 回目の VACUUM

6 回目も20,000 filesを削除した時点で `ICEBERG_VACUUM_MORE_RUNS_NEEDED` になった。実行時間は約41分55秒だった。

| 項目             | 結果                                      |
| ---------------- | ----------------------------------------- |
| QueryExecutionId | `05e66484-6880-43bf-af7d-845ec7fc25a9`    |
| 状態             | `FAILED`                                  |
| 理由             | `ICEBERG_VACUUM_MORE_RUNS_NEEDED`         |
| 開始             | 2026-08-23 18:12:43 JST                   |
| 完了             | 2026-08-23 18:54:37 JST                   |
| Engine execution | 2,514,290 ms（約41分54秒）                |
| Data scanned     | 0 bytes                                   |
| 削除済み files   | 20,000（Athena のエラーメッセージによる） |

<details>
<summary>6 回目の Athena 実行統計</summary>

```json
{
  "status": {
    "State": "FAILED",
    "StateChangeReason": "ICEBERG_VACUUM_MORE_RUNS_NEEDED: Removed 20000 files in this round of vacuum, but there are more files remaining. Please run another VACUUM command to process the remaining files",
    "SubmissionDateTime": "2026-08-23T18:12:43.358000+09:00",
    "CompletionDateTime": "2026-08-23T18:54:37.898000+09:00",
    "AthenaError": {
      "ErrorCategory": 2,
      "ErrorType": 233,
      "Retryable": false,
      "ErrorMessage": "ICEBERG_VACUUM_MORE_RUNS_NEEDED: Removed 20000 files in this round of vacuum, but there are more files remaining. Please run another VACUUM command to process the remaining files"
    }
  },
  "statistics": {
    "EngineExecutionTimeInMillis": 2514290,
    "DataScannedInBytes": 0,
    "TotalExecutionTimeInMillis": 2514540,
    "QueryQueueTimeInMillis": 96,
    "ServicePreProcessingTimeInMillis": 41,
    "QueryPlanningTimeInMillis": 4,
    "ServiceProcessingTimeInMillis": 113,
    "ResultReuseInformation": {
      "ReusedPreviousResult": false
    }
  },
  "engine_version": {
    "SelectedEngineVersion": "Athena engine version 3",
    "EffectiveEngineVersion": "Athena engine version 3"
  }
}
```

</details>

実行前後の S3 と current metadata は次のとおり。

| 項目              |          実行前 |          実行後 | 差分           |
| ----------------- | --------------: | --------------: | -------------- |
| data objects      |          58,980 |          58,982 | +2             |
| data bytes        |     309,110,194 |     309,120,929 | +10,735        |
| metadata objects  |         117,464 |          97,471 | -19,993        |
| metadata bytes    | 910,000,995,313 | 907,997,934,720 | -2,003,060,593 |
| current snapshots |          18,958 |          18,918 | -40            |

metadata は純減19,993 objects、約2.00 GB削減となった。削除件数は前3回と同じ20,000 filesだが、今回は小さいmetadata filesが中心だったため容量の減少幅は小さい。3〜6回目の累計では80,000 filesの削除によりmetadataが79,850 objects、約791.66 GB純減している。

#### 7 回目の VACUUM

7 回目も20,000 filesを削除した時点で `ICEBERG_VACUUM_MORE_RUNS_NEEDED` になった。実行時間は約41分40秒だった。

| 項目             | 結果                                      |
| ---------------- | ----------------------------------------- |
| QueryExecutionId | `ea62b281-901d-4724-a940-68aa15178cc8`    |
| 状態             | `FAILED`                                  |
| 理由             | `ICEBERG_VACUUM_MORE_RUNS_NEEDED`         |
| 開始             | 2026-08-23 18:57:34 JST                   |
| 完了             | 2026-08-23 19:39:14 JST                   |
| Engine execution | 2,499,967 ms（約41分40秒）                |
| Data scanned     | 0 bytes                                   |
| 削除済み files   | 20,000（Athena のエラーメッセージによる） |

<details>
<summary>7 回目の Athena 実行統計</summary>

```json
{
  "status": {
    "State": "FAILED",
    "StateChangeReason": "ICEBERG_VACUUM_MORE_RUNS_NEEDED: Removed 20000 files in this round of vacuum, but there are more files remaining. Please run another VACUUM command to process the remaining files",
    "SubmissionDateTime": "2026-08-23T18:57:34.722000+09:00",
    "CompletionDateTime": "2026-08-23T19:39:14.957000+09:00",
    "AthenaError": {
      "ErrorCategory": 2,
      "ErrorType": 233,
      "Retryable": false,
      "ErrorMessage": "ICEBERG_VACUUM_MORE_RUNS_NEEDED: Removed 20000 files in this round of vacuum, but there are more files remaining. Please run another VACUUM command to process the remaining files"
    }
  },
  "statistics": {
    "EngineExecutionTimeInMillis": 2499967,
    "DataScannedInBytes": 0,
    "TotalExecutionTimeInMillis": 2500235,
    "QueryQueueTimeInMillis": 108,
    "ServicePreProcessingTimeInMillis": 44,
    "QueryPlanningTimeInMillis": 4,
    "ServiceProcessingTimeInMillis": 116,
    "ResultReuseInformation": {
      "ReusedPreviousResult": false
    }
  },
  "engine_version": {
    "SelectedEngineVersion": "Athena engine version 3",
    "EffectiveEngineVersion": "Athena engine version 3"
  }
}
```

</details>

実行前後の S3 と current metadata は次のとおり。

| 項目              |          実行前 |          実行後 | 差分           |
| ----------------- | --------------: | --------------: | -------------- |
| data objects      |          58,983 |          58,985 | +2             |
| data bytes        |     309,126,251 |     309,136,918 | +10,667        |
| metadata objects  |          97,474 |          77,481 | -19,993        |
| metadata bytes    | 908,016,701,639 | 906,192,063,215 | -1,824,638,424 |
| current snapshots |          18,919 |          18,877 | -42            |

metadata は純減19,993 objects、約1.82 GB削減となった。3〜7回目の累計では100,000 filesの削除によりmetadataが99,840 objects、約793.47 GB純減している。

#### 8 回目の VACUUM

8 回目も20,000 filesを削除した時点で `ICEBERG_VACUUM_MORE_RUNS_NEEDED` になった。実行時間は約42分14秒だった。ローカル端末が休止していたためスクリプトのポーリング結果の表示は翌朝になったが、Athena API上の完了日時は2026-08-23 20:25:51 JSTである。

| 項目             | 結果                                      |
| ---------------- | ----------------------------------------- |
| QueryExecutionId | `ef19989b-9580-4604-82d0-0bf91be7c021`    |
| 状態             | `FAILED`                                  |
| 理由             | `ICEBERG_VACUUM_MORE_RUNS_NEEDED`         |
| 開始             | 2026-08-23 19:43:38 JST                   |
| 完了             | 2026-08-23 20:25:51 JST                   |
| Engine execution | 2,533,623 ms（約42分14秒）                |
| Data scanned     | 0 bytes                                   |
| 削除済み files   | 20,000（Athena のエラーメッセージによる） |

<details>
<summary>8 回目の Athena 実行統計</summary>

```json
{
  "status": {
    "State": "FAILED",
    "StateChangeReason": "ICEBERG_VACUUM_MORE_RUNS_NEEDED: Removed 20000 files in this round of vacuum, but there are more files remaining. Please run another VACUUM command to process the remaining files",
    "SubmissionDateTime": "2026-08-23T19:43:38.022000+09:00",
    "CompletionDateTime": "2026-08-23T20:25:51.896000+09:00",
    "AthenaError": {
      "ErrorCategory": 2,
      "ErrorType": 233,
      "Retryable": false,
      "ErrorMessage": "ICEBERG_VACUUM_MORE_RUNS_NEEDED: Removed 20000 files in this round of vacuum, but there are more files remaining. Please run another VACUUM command to process the remaining files"
    }
  },
  "statistics": {
    "EngineExecutionTimeInMillis": 2533623,
    "DataScannedInBytes": 0,
    "TotalExecutionTimeInMillis": 2533874,
    "QueryQueueTimeInMillis": 62,
    "ServicePreProcessingTimeInMillis": 48,
    "QueryPlanningTimeInMillis": 4,
    "ServiceProcessingTimeInMillis": 141,
    "ResultReuseInformation": {
      "ReusedPreviousResult": false
    }
  },
  "engine_version": {
    "SelectedEngineVersion": "Athena engine version 3",
    "EffectiveEngineVersion": "Athena engine version 3"
  }
}
```

</details>

実行前の値は19:42〜19:43 JST、実行後の値は端末復帰後の2026-08-24 04:06 JSTに取得した。この間もFirehoseの書き込みが継続しているため、次の差分はVACUUM単独の削除量ではなく約8時間分の新規書き込みを含む純増減である。

| 項目              |          実行前 |          実行後 | 差分           |
| ----------------- | --------------: | --------------: | -------------- |
| data objects      |          58,985 |          59,016 | +31            |
| data bytes        |     309,136,918 |     309,302,286 | +165,368       |
| metadata objects  |          77,481 |          57,575 | -19,906        |
| metadata bytes    | 906,192,063,215 | 904,956,431,645 | -1,235,631,570 |
| current snapshots |          18,877 |          18,865 | -12            |

metadata は新規書き込みを含めても純減19,906 objects、約1.24 GB削減となった。3〜8回目の累計では120,000 filesの削除によりmetadataが119,746 objects、約794.70 GB純減している。

#### 9 回目の VACUUM（完了）

9 回目は `SUCCEEDED` となり、`ICEBERG_VACUUM_MORE_RUNS_NEEDED` が解消した。実行時間は約40分36秒だった。

| 項目             | 結果                                   |
| ---------------- | -------------------------------------- |
| QueryExecutionId | `ab1f8281-75e8-465d-a8e7-5a3a6c5edc94` |
| 状態             | `SUCCEEDED`                            |
| 開始             | 2026-08-24 04:07:36 JST                |
| 完了             | 2026-08-24 04:48:12 JST                |
| Engine execution | 2,435,849 ms（約40分36秒）             |
| Data scanned     | 0 bytes                                |

<details>
<summary>9 回目の Athena 実行統計</summary>

```json
{
  "status": {
    "State": "SUCCEEDED",
    "SubmissionDateTime": "2026-08-24T04:07:36.731000+09:00",
    "CompletionDateTime": "2026-08-24T04:48:12.765000+09:00"
  },
  "statistics": {
    "EngineExecutionTimeInMillis": 2435849,
    "DataScannedInBytes": 0,
    "TotalExecutionTimeInMillis": 2436034,
    "QueryQueueTimeInMillis": 89,
    "ServicePreProcessingTimeInMillis": 54,
    "QueryPlanningTimeInMillis": 4,
    "ServiceProcessingTimeInMillis": 42,
    "ResultReuseInformation": {
      "ReusedPreviousResult": false
    }
  },
  "engine_version": {
    "SelectedEngineVersion": "Athena engine version 3",
    "EffectiveEngineVersion": "Athena engine version 3"
  }
}
```

</details>

実行前後の S3 と current metadata は次のとおり。実行中もFirehoseが配信を継続したため、data objectsが2件増えている。

| 項目              |          実行前 |          実行後 | 差分            |
| ----------------- | --------------: | --------------: | --------------- |
| data objects      |          59,016 |          59,018 | +2              |
| data bytes        |     309,302,286 |     309,313,388 | +11,102         |
| metadata objects  |          57,575 |          55,457 | -2,118          |
| metadata bytes    | 904,956,431,645 | 885,899,610,435 | -19,056,821,210 |
| current snapshots |          18,865 |          18,389 | -476            |

9 回目では残っていた対象を削除して正常完了し、metadataはさらに2,118 objects、約19.06 GB純減した。quota反映後の3〜9回目全体では、3〜8回目の120,000 files削除に加えて最終回の残存対象を削除し、次の結果となった。

| 項目              |      3 回目実行前 |    9 回目実行後 | 差分               |
| ----------------- | ----------------: | --------------: | ------------------ |
| data objects      |            59,009 |          59,018 | +9                 |
| data bytes        |       309,260,637 |     309,313,388 | +52,751            |
| metadata objects  |           177,321 |          55,457 | -121,864（-68.7%） |
| metadata bytes    | 1,699,657,790,869 | 885,899,610,435 | -813,758,180,434   |
| current snapshots |            19,513 |          18,389 | -1,124             |

最終的にmetadataは約813.76 GB（約47.9%）削減できた。dataの微増は処理中もFirehoseの配信が正常に継続したためである。残存55,457 objectsには、14日以内のtime travelに必要なsnapshot・manifest・metadata logと、継続配信で生成される現行ファイルが含まれる。Firehoseの900秒化は本番まで適用済みのため、適用前の約60秒周期で生成されたsnapshotが14日の保持期間外へ抜けた後に再度 `VACUUM` を実行し、定常状態まで減少したことを確認する。

## 対応チェックリスト

- [x] Cost Explorer で S3 の Cost / Usage Type / Operation を確認
- [x] バケット別の容量と object 数を確認
- [x] `data/` と `metadata/` の容量を分離
- [x] 現在の metadata JSON で snapshot 数を確認
- [x] 原因を Firehose のコミット頻度と未実施の snapshot expiration に特定
- [x] time travel 保持期間を 14 日に決定
- [x] 保持期間を設定する Athena DDL を番号付き SQL で差分管理
- [x] 初回適用・VACUUM・前後比較用スクリプトを作成
- [x] 14 日保持の Athena DDL を適用
- [x] Athena 実行ロールの `s3:DeleteObject` 権限を実削除結果で確認
- [x] 30 分上限で `VACUUM` を再実行（2 回目も `Query timeout`）
- [x] Athena DML query timeout quota を 240 分へ引き上げる（申請から約 5 時間 49 分で反映確認）
- [x] quota 反映後に3〜9回目の `VACUUM` を実行（9回目で `SUCCEEDED`）
- [x] `ICEBERG_VACUUM_MORE_RUNS_NEEDED` が解消するまで `VACUUM` を反復
- [x] 実行後の容量・クエリ・Firehose 配信を確認
- [x] Firehose buffer interval 900 秒を CDK へ実装
- [x] Firehose buffer interval 900 秒を本番までデプロイ
- [x] 定期 VACUUM を CDK へ実装
- [x] 手動 VACUUM の正常完了後、日次スケジュールを有効化
- [x] 初回定期実行の失敗原因をIceberg metadataへの `s3:PutObject` 不足と特定
- [x] 定期VACUUM用ロールへmetadata prefix限定の `s3:PutObject` を追加
- [ ] IAM修正をデプロイし、VACUUMの正常完了を確認
- [ ] 必要に応じて通常 S3 + partitioned Parquet への移行を判断
