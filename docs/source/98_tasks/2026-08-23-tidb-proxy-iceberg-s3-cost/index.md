<!-- cspell:ignore UnblendedCost TBLPROPERTIES -->

# tidb-proxy Iceberg メタデータによる S3 高額化の調査と対応

- 起票日: 2026-08-23
- 対象環境: dev / prd 共用ログ基盤
- 対象: `tidb-proxy-logs-<account>` / Glue `tidb_proxy_logs.logs`
- ステータス: 調査完了、snapshot 保持期間は 14 日に決定、初回 VACUUM 実行待ち
- 関連タスク: [tidb-proxy: ログを FireLens で振り分けて S3/Iceberg + Athena で検索可能にする](../2026-07-10-tidb-proxy-log-iceberg/index.md)
- 関連実装: `iac/aws/lib/analytics/tidb-proxy-log-analytics-construct.ts`

## 結論

S3 高額化の原因はログデータ本体ではなく、Amazon Data Firehose が約 60 秒ごとに作成する Apache Iceberg の snapshot と metadata JSON である。

2026-08-23 の調査時点で、実ログデータは約 293 MiB しかないのに対し、`iceberg/logs/metadata/` は約 1.57 TiB まで増えていた。現在の metadata JSON は 58,433 件の snapshot 履歴を内包して約 57.8 MB あり、コミットのたびに履歴全体を含む新しい metadata JSON が作成される。古い snapshot を `VACUUM` していないため、メタデータ総量がほぼ二次関数的に増加している。

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

`bufferingHints.intervalInSeconds` を 60 秒から 900 秒へ延長する。Firehose の値は hint だが、低トラフィック時のコミット頻度と S3 書き込み回数を最大で約 15 分の 1 に抑えられる。

```diff
 bufferingHints: {
-  intervalInSeconds: 60,
+  intervalInSeconds: 900,
   sizeInMBs: 64,
 },
```

トレードオフとして、Athena から検索可能になるまで最大約 15 分の遅延を許容する。障害系ログは従来どおり CloudWatch Logs に送るため、INFO 系ログだけの遅延である。

### 3. 再発防止: VACUUM の定期実行

バッファ間隔を延ばしても snapshot は増え続けるため、定期 `VACUUM` が必要。日次実行を第一候補とし、実行後の snapshot 数・metadata 容量・失敗状態を監視する。

実装候補:

- EventBridge Scheduler から Lambda を起動し、Athena `StartQueryExecution` で `VACUUM` を実行
- 実行結果は Athena `GetQueryExecution` で確認し、失敗時は CloudWatch Alarm / 通知へ接続
- WorkGroup は既存の `tidb-proxy-logs` を使用

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

未実施。`scripts/maintain-tidb-proxy-iceberg.sh` の実行後に、以下を記録する。

- retention 設定 query の QueryExecutionId / 成否
- VACUUM query の QueryExecutionId / 成否
- 実行前後の data / metadata の object 数と容量
- 実行前後の snapshot 数
- Athena SELECT と Firehose 配信の正常性

## 対応チェックリスト

- [x] Cost Explorer で S3 の Cost / Usage Type / Operation を確認
- [x] バケット別の容量と object 数を確認
- [x] `data/` と `metadata/` の容量を分離
- [x] 現在の metadata JSON で snapshot 数を確認
- [x] 原因を Firehose のコミット頻度と未実施の snapshot expiration に特定
- [x] time travel 保持期間を 14 日に決定
- [x] 保持期間を設定する Athena DDL を番号付き SQL で差分管理
- [x] 初回適用・VACUUM・前後比較用スクリプトを作成
- [ ] Athena 実行ロールの `s3:DeleteObject` 権限を確認
- [ ] `VACUUM tidb_proxy_logs.logs` を実行
- [ ] 実行後の容量・クエリ・Firehose 配信を確認
- [ ] Firehose buffer interval を 900 秒へ変更
- [ ] 定期 VACUUM を IaC 化
- [ ] 必要に応じて通常 S3 + partitioned Parquet への移行を判断
