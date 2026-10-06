# tidb-proxy ログの Iceberg テーブルを S3 Tables へ移行する

- 起票日: 2026-10-06
- 対象環境: dev / prd 共用ログ基盤 (`st-tidb-proxy-logs`)
- ステータス: 2026-10-06 に dev / prd 共用環境へ適用済み。旧 Glue テーブルと `iceberg/` prefix は 2026-10-07 に撤去済み
- 関連タスク:
  - [tidb-proxy: ログを FireLens で振り分けて S3/Iceberg + Athena で検索可能にする](../2026-07-10-tidb-proxy-log-iceberg/index.md)
  - [tidb-proxy Iceberg メタデータによる S3 高額化の調査と対応](../2026-08-23-tidb-proxy-iceberg-s3-cost/index.md)
- 関連実装: `iac/aws/lib/analytics/tidb-proxy-log-analytics-construct.ts`

## 背景

通常 S3 + Glue Data Catalog の Iceberg テーブルでは、snapshot expiration / orphan file removal を自前で回す必要がある。2026-08 に metadata が約 1.5 TiB まで膨らみ、日次 Athena `VACUUM`（Step Functions + EventBridge）と保持期間 SQL を運用で抱えることになった。

2026-07-10 の設計時は「S3 Tables は Lake Formation 統合の設定が増える」ため見送ったが、その後 S3 Tables と AWS 分析サービスの統合は **IAM アクセス制御がデフォルト** になり、Lake Formation は任意になった（2026-03-17 の [What's New](https://aws.amazon.com/about-aws/whats-new/2026/03/gdc-simplified-permissions-s3tables-iceberg-views/)、S3 User Guide「Integrating Amazon S3 Tables with AWS analytics services」）。前提が変わったため、メンテナンスを S3 Tables のマネージド機能に寄せる。

## 意思決定

### 決定事項

| #   | 決定                                                                                                                 | 一言理由                                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| D1  | Iceberg テーブルを通常 S3 + Glue から **S3 Tables** に移す                                                           | テーブルメンテナンスの自前運用をやめる                                           |
| D2  | 統合は **IAM アクセス制御モード**。**Lake Formation は使わない**                                                     | 2026-07-10 に見送った理由（LF の設定コスト）が解消されている                     |
| D3  | VACUUM の自前運用（Step Functions / EventBridge / スクリプト / SQL）を撤去                                           | S3 Tables のマネージドメンテナンスと二重になる                                   |
| D4  | **既存データは移行しない**。旧テーブルは確認後に撤去（2026-10-07 実施）                                              | 過去のアクセスログを遡って調べる需要が低い                                       |
| D5  | Firehose は新 stream `tidb-proxy-logs-s3tables` を並走させて切り替える（当初は名前維持の予定。「デプロイ経緯」参照） | 宛先 catalog の変更は stream の replacement になり、固定名のままでは更新できない |

### 検討した選択肢 (D1 / D2)

| 案                                         | メンテナンス                                                       | 構成の複雑さ                                                                  | 判断                                           |
| ------------------------------------------ | ------------------------------------------------------------------ | ----------------------------------------------------------------------------- | ---------------------------------------------- |
| A. 現状維持（通常 S3 + Glue + 日次VACUUM） | 自前。VACUUM 停止で metadata が二次関数的に増える                  | Step Functions / EventBridge / IAM 調整を抱え続ける                           | 不採用。2026-08 の高額化の再発リスクが残る     |
| B. **S3 Tables + IAM アクセス制御**        | compaction / snapshot 期限切れ / 未参照ファイル削除を AWS が実施   | `AWS::Glue::Catalog` 1 つと IAM のみ。全て CFN で書ける                       | **採用**                                       |
| C. S3 Tables + Lake Formation              | B と同じ                                                           | data location 登録・LF grant・LF 管理者設定が増える                           | 不採用。細かい権限制御が不要な単一運用者の構成 |
| D. Iceberg をやめて gzip JSONL にする      | 不要（テーブルの状態を持たない）。保持期間は S3 Lifecycle で切れる | Firehose 宛先・Glue テーブル（partition projection）・Athena クエリを作り直す | 不採用。後述                                   |

### 判断の根拠

- 2026-07-10 の不採用理由は「Lake Formation 統合の設定が増える」だった。現在の AWS ドキュメントでは統合は IAM 権限がデフォルトで、Lake Formation は任意（S3 User Guide「Integrating Amazon S3 Tables with AWS analytics services」、Firehose Developer Guide「Grant Firehose access to Amazon S3 Tables」の IAM access control）
- 2026-08-23 の高額化は Iceberg の snapshot / metadata を expire しなかったことが原因で、データ量ではなく **メンテナンスの欠如** が問題だった。メンテナンスをマネージドに寄せるのが根本対策になる
- 案 D について。append only でデータ量が少なく、Athena からしか読まないログなので、Iceberg の機能（ACID・行単位の更新削除・ファイル統計による読み飛ばし・time travel）はほぼ効かず、gzip JSONL でも要件は満たせる。全件スキャンしても Athena は 1 クエリ $0.002 未満。ただし S3 Tables なら FireLens → Firehose (Iceberg 宛先) → Athena の流れをそのまま残し、テーブルの置き場所を替えるだけで済む。JSONL は宛先とクエリ層の作り直しになるため、変更量が小さい案 B を採る
- データ量（数百 MiB 規模）では、S3 Tables のストレージ単価の上乗せ（S3 Standard 比 約 15%）や監視・compaction 料金は月数セントの見込みで、自前運用のコストより小さい

### 受け入れるトレードオフ

- `s3tablescatalog` はアカウント・リージョンで 1 つの federated catalog で、それを本スタックが所有する。本スタックを destroy すると他の table bucket の分析サービス統合にも影響する（現時点で他の table bucket は無い）
- Firehose ロールの Glue 権限は、federated catalog 配下の ARN 形式を確認しきれていないため、ドキュメントどおり `database/*` / `table/*/*` のワイルドカードとする（action は Get 系と `UpdateTable` のみ）
- Athena の Named Query は catalog を指定できないため、FROM 句を `"s3tablescatalog/..."` で完全修飾する
- 旧テーブル撤去までは、残存している `iceberg/` prefix 分の S3 料金がかかる
- ログの保持期間を S3 Lifecycle で切れない。古い行を消す必要が出た場合は Athena の `DELETE` を定期実行する（現状のデータ量では消さない）

### 見直す条件

- 他用途で table bucket を追加する場合、`s3tablescatalog` を共通スタックへ切り出す
- 列単位・行単位のアクセス制御が必要になった場合は案 C（Lake Formation）を再検討する
- S3 Tables の月額が想定（月数セント〜数十セント）を大きく超えた場合は Cost Explorer で内訳を確認する
- 保持期間による削除が必要になった場合や、S3 Tables 固有の運用が負担になった場合は案 D（gzip JSONL + S3 Lifecycle）を再検討する

## 構成

```text
FireLens ──▶ Firehose (tidb-proxy-logs-s3tables)
               ├─ 正常 ─▶ S3 Tables: table bucket tidb-proxy-logs-tables
               │           └─ namespace tidb_proxy_logs / table logs
               └─ 失敗 ─▶ 汎用バケット tidb-proxy-logs-<account>/firehose-errors/
Athena ──▶ "s3tablescatalog/tidb-proxy-logs-tables"."tidb_proxy_logs"."logs"
```

| リソース                     | 設定                                                                                               |
| ---------------------------- | -------------------------------------------------------------------------------------------------- |
| `AWS::S3Tables::TableBucket` | `tidb-proxy-logs-tables`。未参照ファイル削除 Enabled（既定: unreferenced 3 日 / noncurrent 10 日） |
| `AWS::S3Tables::Namespace`   | `tidb_proxy_logs`（Firehose の制約でハイフン不可）                                                 |
| `AWS::S3Tables::Table`       | `logs`。スキーマは旧テーブルと同一。compaction enabled、snapshot 保持 336 時間（14 日）            |
| `AWS::Glue::Catalog`         | `s3tablescatalog`。`IAM_ALLOWED_PRINCIPALS` に ALL、`AllowFullTableExternalDataAccess`             |
| Firehose `CatalogArn`        | `arn:aws:glue:<region>:<account>:catalog/s3tablescatalog/tidb-proxy-logs-tables`                   |
| Firehose ロール              | s3tables はこの table bucket / table に限定。Glue は Firehose 開発者ガイドの ARN どおり            |
| Athena Named Query           | NamedQuery に catalog 指定が無いため FROM 句で完全修飾                                             |
| デプロイロール               | `s3tables:*` を追加（`glue:CreateCatalog` / `glue:PassConnection` は既存の `glue:*`）              |

Firehose は S3 Tables 宛てではテーブルを自動作成しないため、スキーマ付きの `AWS::S3Tables::Table` を CDK で先に作る。

## デプロイ前の確認

IAM だけでの権限管理は「一部リージョン」での提供と発表されている。東京リージョン (ap-northeast-1) が対象に含まれることを、上記 What's New からリンクされているドキュメントで確認する。

`s3tablescatalog` はアカウント・リージョンで 1 つ。旧来のコンソール手順（Lake Formation 方式）で統合済みの場合、`AWS::Glue::Catalog` の作成が名前衝突で失敗する。

```bash
# NotFound なら CDK で作成してよい。存在する場合は CatalogInput と作成経緯を確認する
aws glue get-catalog --catalog-id s3tablescatalog

# Lake Formation に s3tablescatalog のデータロケーションが登録されていないこと
aws lakeformation list-resources --query 'ResourceInfoList[?contains(ResourceArn, `s3tables`)]'
```

replacement の有無は `cdk diff`（既定の change set 方式）で確認する。`--no-change-set` / `--method=template` は template の差分しか見ないため、リソースハンドラ側の replacement（今回の Firehose `CatalogArn` 変更など）を検出できない。

```bash
cd iac/aws
bunx dotenv -- cdk deploy -c stageName=dev d-st-deploy-role --require-approval never
bunx dotenv -- cdk diff -c stageName=dev st-tidb-proxy-logs
```

### 確認結果 (2026-10-06)

| 項目                               | 結果                                                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `glue get-catalog s3tablescatalog` | `EntityNotFoundException`（未作成。CDK で作成してよい）                                                                                     |
| Lake Formation 登録リソース        | なし                                                                                                                                        |
| Lake Formation data lake settings  | Admin なし、DB / Table のデフォルト権限は `IAM_ALLOWED_PRINCIPALS: ALL`（IAM のみの状態）                                                   |
| S3 Tables table bucket             | なし                                                                                                                                        |
| Firehose 現行 `CatalogARN`         | `arn:aws:glue:ap-northeast-1:<account>:catalog`（default catalog）                                                                          |
| 日次 VACUUM                        | 2026-10-06 03:00 JST 実行分まで `SUCCEEDED`                                                                                                 |
| `cdk diff --no-change-set`         | DeliveryStream は `CatalogArn` と `DependsOn` のみの差分に見えた。**template diff は replacement を判定できず誤り**（「デプロイ経緯」参照） |

`cdk diff` のその他の差分は、S3 Tables / `s3tablescatalog` の追加、VACUUM 関連 7 リソースの削除、Firehose ロールのポリシー更新、Named Query 3 件の replace（`QueryString` 変更による。名前は同じで作り直されるだけ）。旧 `GlueDatabase` / `LogsTable` は残る。

## デプロイ経緯 (2026-10-06)

| 時刻 (JST) | 操作                                                                | 結果                                                                                                                                                                                                |
| ---------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 15:01      | 既存 stream `tidb-proxy-logs` の宛先を S3 Tables へ変更してデプロイ | `UPDATE_FAILED`: "CloudFormation cannot update a stack when a custom-named resource requires replacing"。`CatalogArn` の変更は replacement になる。自動ロールバックで元の状態に戻った               |
| 15:06      | 新 stream を並走させる構成でデプロイ                                | `CREATE_FAILED`: table bucket `tidb-proxy-logs` が "transitional state because of a previous deletion attempt"（1 回目のロールバックで削除された直後のため同名を再作成できない）。再度ロールバック  |
| 15:10      | table bucket 名を `tidb-proxy-logs-tables` に変更して再デプロイ     | 成功。新 stream `tidb-proxy-logs-s3tables` が作成され、SSM `/tidb-proxy/logs/delivery-stream-name` が新名に更新                                                                                     |
| 15:15      | `ecspresso deploy`（`IMAGE_TAG=c3a0289`、イメージは再ビルドしない） | `tidb-proxy:19` に切り替え。`minimumHealthyPercent: 0` のため 15:15:24〜15:16:16 の約 50 秒 proxy が停止                                                                                            |
| 15:34      | 旧 stream / 旧 Firehose ロールを CDK から削除してデプロイ           | 成功。旧 stream のバッファ（15:27 の 5 分値で最後の 10 行）が flush 済みであることを確認してから削除。旧 log stream `iceberg-delivery` は CFN 管理外として残る（log group の保持 2 週間で期限切れ） |

学び:

- Firehose の `IcebergDestinationConfiguration.CatalogConfiguration.CatalogArn` 変更は replacement になる。固定名の stream は別名で並走させて切り替える
- S3 Tables の table bucket は削除直後しばらく同名で作り直せない。ロールバックで消えた名前は再利用せず別名にする
- ecspresso の差分は `FIREHOSE_DELIVERY_STREAM` のみ。ほか 2 件（`healthCheckGracePeriodSeconds: 0` / log-router の `user: "0"`）は AWS 側のデフォルト値の表示差分

## デプロイと動作確認

```bash
bunx dotenv -- cdk deploy -c stageName=dev st-tidb-proxy-logs --require-approval never

# バッファ間隔 (900 秒) 経過後に S3 Tables 側へ行が入ること
aws athena start-query-execution \
  --work-group tidb-proxy-logs \
  --query-string 'SELECT ts, log_type, level, method, url, status FROM "s3tablescatalog/tidb-proxy-logs-tables"."tidb_proxy_logs"."logs" ORDER BY ts DESC LIMIT 20'

# 配信失敗レコードが増えていないこと
aws s3 ls s3://tidb-proxy-logs-$(aws sts get-caller-identity --query Account --output text)/firehose-errors/ --recursive
```

### 動作確認結果 (2026-10-06 15:33)

| 項目                                                          | 結果                                                                                   |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `DeliveryToIceberg.SuccessfulRowCount` (新 stream)            | 41（15:27 の 5 分値）。`FailedRowCount` は 0                                           |
| Firehose エラーログ / `firehose-errors/`                      | どちらも出力なし                                                                       |
| Athena `count(*)`（`s3tablescatalog/tidb-proxy-logs-tables`） | 41 行。先頭は 15:15:53 JST（新 task 起動時刻）、うち `squid_access` 29 行              |
| Named Query 3 件                                              | 作り直し後も名前・説明文は正常                                                         |
| 東京リージョンでの IAM アクセス制御モード                     | `s3tablescatalog` 作成・Firehose 配信・Athena 参照まで Lake Formation なしで動作を確認 |

### 料金確認 (2026-10-07 07:15 JST)

Cost Explorer（UTC 日次、Amazon S3）:

| 日                          |    S3 合計 | 内訳                                                                                              |
| --------------------------- | ---------: | ------------------------------------------------------------------------------------------------- |
| 10/01〜10/05（切り替え前）  | 約 $0.0062 | TimedStorage $0.0021 / Requests-Tier1 $0.0019（約 415 件）/ Requests-Tier2 $0.0022（約 5,850 件） |
| 10/06（15:15 JST 切り替え） |    $0.0051 | 通常 S3 $0.0040 + `APN1-Tables-Requests-Tier1` $0.00078（167 件）/ `-Tier2` $0.00027（734 件）    |

S3 Tables の状態（切り替えから約 16 時間）:

| 項目                          | 値                                                                         |
| ----------------------------- | -------------------------------------------------------------------------- |
| 行数                          | 2,027                                                                      |
| data files（`logs$files`）    | 13 個 / 72 KB（compaction 済み。最終実行 2026-10-07 06:59 JST Successful） |
| snapshots（`logs$snapshots`） | 58 個（約 90 個/日。14 日保持で約 1,300 個で頭打ちの想定）                 |
| snapshot management           | Successful（2026-10-06 23:53 JST）                                         |
| unreferenced file removal     | Not_Yet_Run（unreferenced 3 日 + noncurrent 10 日のため現時点では正常）    |
| 汎用バケット容量              | 約 2.04 GB（旧 `iceberg/` が大半。撤去まで約 $0.06/月）                    |

所見:

- S3 日額は切り替え前と同程度かやや減。旧テーブルへの書き込みと VACUUM の GET が止まり、代わりに S3 Tables のリクエスト料金（約 $0.002〜0.003/日の見込み）が乗る
- S3 Tables の storage / monitoring / compaction はまだ請求に出ない規模
- 要確認: snapshot 数に比例して大きくなる metadata JSON の旧版が unreferenced file removal で消えるか。10/10 以降に Cost Explorer の S3 Tables storage が横ばいであることを確認する

## 旧テーブルの撤去 (2026-10-07)

切り替え後 1 日の動作・料金確認を経て、同じ PR で撤去した。

| 時刻 (JST)   | 操作                                                                         | 結果                                                                                                                                                                                              |
| ------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 07:20        | 事前確認                                                                     | 汎用バケットはバージョニング無効。`iceberg/` は 66,760 objects / 約 2.06 GB、最終書き込みは 10/06 15:27 JST（旧 stream の最終 flush）。`cdk diff` は `GlueDatabase` / `LogsTable` の destroy のみ |
| 07:23        | CDK から `GlueDatabase` / `LogsTable` と `legacyGlue` 設定を削除してデプロイ | `DELETE_COMPLETE`                                                                                                                                                                                 |
| 07:23〜07:28 | `aws s3 rm s3://tidb-proxy-logs-<account>/iceberg/ --recursive`              | 0 objects。残る prefix は `athena-results/` / `firelens-config/`                                                                                                                                  |
| 07:28        | CFN 管理外で残っていた旧 log stream `iceberg-delivery` を削除                | log group には `s3tables-delivery` のみ                                                                                                                                                           |

Named Query の `Database` プロパティ（`tidb_proxy_logs`）は default catalog に実体が無くなったが、FROM 句を完全修飾しているため実行に影響しない（`recent-activity` を `Catalog=AwsDataCatalog,Database=tidb_proxy_logs` のコンテキストで実行して `SUCCEEDED` を確認）。

## 料金の目安

S3 Tables はストレージ単価が S3 Standard より約 15% 高い（us-east-1 で $0.0265/GB-月）ほか、オブジェクト監視（$0.025 / 1,000 objects）と compaction（$0.002 / 1,000 objects + $0.005 / GB）が課金される。実データは数百 MiB 規模のため月数セント程度の見込み。東京リージョンの正確な単価は Pricing Calculator で確認する。
