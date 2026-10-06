import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as athena from 'aws-cdk-lib/aws-athena';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as firehose from 'aws-cdk-lib/aws-kinesisfirehose';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as s3tables from 'aws-cdk-lib/aws-s3tables';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { type LogAnalyticsParameter } from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ログテーブルのスキーマ。apps/tidb-proxy/firelens/extra.conf の Allowlist_key と揃える。
// ts は timestamp 型ではなく string (ISO8601) にする。Firehose の JSON -> timestamp
// 変換フォーマット要求に依存しないためで、Athena では from_iso8601_timestamp(ts) で
// 時刻演算する。型は Iceberg の primitive type。
const LOG_COLUMNS: { name: string; type: string }[] = [
  { name: 'ts', type: 'string' },
  { name: 'log_type', type: 'string' },
  { name: 'level', type: 'string' },
  { name: 'message', type: 'string' },
  { name: 'client_ip', type: 'string' },
  { name: 'method', type: 'string' },
  { name: 'url', type: 'string' },
  { name: 'http_version', type: 'string' },
  { name: 'status', type: 'int' },
  { name: 'bytes_in', type: 'long' },
  { name: 'bytes_out', type: 'long' },
  { name: 'duration_ms', type: 'long' },
  { name: 'user_agent', type: 'string' },
  { name: 'squid_status', type: 'string' },
  { name: 'hier_status', type: 'string' },
];

// tidb-proxy のログ分析基盤。FireLens (Fluent Bit) が振り分けた INFO 系ログを
// Firehose 経由で S3 Tables (マネージド Iceberg) に蓄積し、Athena で検索する。
// 設計は docs/source/98_tasks/2026-07-10-tidb-proxy-log-iceberg/index.md と
// docs/source/98_tasks/2026-10-06-tidb-proxy-logs-s3-tables/index.md を参照。
//
// 稼働中の st-tidb-proxy スタックには手を入れず、SSM 出力経由でタスクロールを
// インポートして必要な権限を後付けする (blog-api-construct が proxy SG に
// addIngressRule するのと同型のパターン)。
export class TidbProxyLogAnalyticsConstruct extends Construct {
  public readonly bucket: s3.Bucket;
  public readonly deliveryStream: firehose.CfnDeliveryStream;

  constructor(
    scope: Construct,
    id: string,
    props: {
      config: LogAnalyticsParameter;
    },
  ) {
    super(scope, id);

    const { config } = props;

    // ---- S3 Bucket (汎用) ----
    // prefix で用途を分離する:
    //   firehose-errors/ Firehose 配信失敗レコード (デバッグ用途のみ)
    //   athena-results/  Athena クエリ結果 (一時ファイル)
    //   firelens-config/ Fluent Bit 設定 (BucketDeployment で git と同期)
    // autoDeleteObjects は既存 ECR / LogGroup と同じ「個人ブログ用途で簡単に
    // 畳める」方針の割り切り。cdk destroy でログ資産ごと消える点に注意。
    this.bucket = new s3.Bucket(this, 'LogsBucket', {
      bucketName: `${config.projectName}-${cdk.Aws.ACCOUNT_ID}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [
        {
          id: 'expire-firehose-errors',
          prefix: 'firehose-errors/',
          expiration: cdk.Duration.days(30),
        },
        {
          id: 'expire-athena-results',
          prefix: 'athena-results/',
          expiration: cdk.Duration.days(7),
        },
      ],
    });

    // ---- FireLens 設定の配置 ----
    // aws-for-fluent-bit の init プロセスがタスク起動時に取得する。反映には
    // タスクの再起動 (ecs update-service --force-new-deployment) が必要。
    new s3deploy.BucketDeployment(this, 'FirelensConfigDeployment', {
      sources: [
        s3deploy.Source.asset(path.resolve(__dirname, '../../../../apps/tidb-proxy/firelens')),
      ],
      destinationBucket: this.bucket,
      destinationKeyPrefix: 'firelens-config',
      prune: true,
    });

    // ---- S3 Tables ----
    // compaction / snapshot expiration / 未参照ファイル削除を S3 Tables のマネージド
    // メンテナンスに任せる。旧構成で自前運用していた Athena VACUUM の代替。
    //
    // 未参照ファイル削除の日数は既定値 (unreferenced 3 日 / noncurrent 10 日)。
    const tableBucket = new s3tables.CfnTableBucket(this, 'TableBucket', {
      tableBucketName: config.s3Tables.tableBucketName,
      unreferencedFileRemoval: {
        status: 'Enabled',
      },
    });
    const namespace = new s3tables.CfnNamespace(this, 'TableNamespace', {
      tableBucketArn: tableBucket.attrTableBucketArn,
      namespace: config.s3Tables.namespace,
    });
    // Firehose は S3 Tables 宛てではテーブルを自動作成しないため、スキーマ付きで先に作る。
    const logsS3Table = new s3tables.CfnTable(this, 'LogsS3Table', {
      tableBucketArn: tableBucket.attrTableBucketArn,
      namespace: config.s3Tables.namespace,
      tableName: config.s3Tables.tableName,
      openTableFormat: 'ICEBERG',
      icebergMetadata: {
        icebergSchema: {
          schemaFieldList: LOG_COLUMNS.map(({ name, type }) => ({
            name,
            type,
            required: false,
          })),
        },
      },
      compaction: {
        status: 'enabled',
      },
      // time travel 用の snapshot 保持期間。旧構成の
      // vacuum_max_snapshot_age_seconds (14 日) を引き継ぐ。
      snapshotManagement: {
        status: 'enabled',
        maxSnapshotAgeHours: config.s3Tables.maxSnapshotAgeHours,
        minSnapshotsToKeep: 1,
      },
    });
    logsS3Table.addDependency(namespace);

    // S3 Tables と Glue Data Catalog / Athena / Firehose の統合 (IAM アクセス制御モード)。
    // `s3tablescatalog` はアカウント・リージョンで 1 つの federated catalog で、
    // 配下に全テーブルバケットが現れる。Lake Formation は使わない。
    const s3TablesDefaultPermissions = [
      {
        principal: { dataLakePrincipalIdentifier: 'IAM_ALLOWED_PRINCIPALS' },
        permissions: ['ALL'],
      },
    ];
    const s3TablesCatalog = new glue.CfnCatalog(this, 'S3TablesCatalog', {
      name: 's3tablescatalog',
      federatedCatalog: {
        identifier: `arn:aws:s3tables:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:bucket/*`,
        connectionName: 'aws:s3tables',
      },
      createDatabaseDefaultPermissions: s3TablesDefaultPermissions,
      createTableDefaultPermissions: s3TablesDefaultPermissions,
      allowFullTableExternalDataAccess: 'True',
    });

    // ---- Firehose (Direct PUT -> S3 Tables) ----
    // 宛先 catalog の変更は replacement を伴うため、旧 Glue Iceberg 宛ての stream
    // (tidb-proxy-logs) とは別名で作り、FireLens を切り替えた後に旧 stream を撤去した。
    const firehoseLogGroup = new logs.LogGroup(this, 'FirehoseLogGroup', {
      logGroupName: `/aws/kinesisfirehose/${config.projectName}`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const firehoseLogStream = new logs.LogStream(this, 'S3TablesFirehoseLogStream', {
      logGroup: firehoseLogGroup,
      logStreamName: 's3tables-delivery',
    });

    const firehoseRole = new iam.Role(this, 'S3TablesFirehoseRole', {
      roleName: `${config.projectName}-firehose-s3tables`,
      assumedBy: new iam.ServicePrincipal('firehose.amazonaws.com'),
    });
    // 必要な権限は Firehose 開発者ガイドの「Grant Firehose access to Amazon S3 Tables」
    // (IAM access control) に従う。s3tables はこのテーブルバケット / テーブルに絞る。
    firehoseRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          's3tables:GetTableBucket',
          's3tables:GetNamespace',
          's3tables:GetTable',
          's3tables:GetTableData',
          's3tables:GetTableMetadataLocation',
          's3tables:PutTableData',
          's3tables:UpdateTableMetadataLocation',
        ],
        resources: [tableBucket.attrTableBucketArn, logsS3Table.attrTableArn],
      }),
    );
    // federated catalog 配下の database / table の Glue ARN はガイドの記載どおり
    // ワイルドカードで指定する。catalog はこのテーブルバケットに絞る。
    firehoseRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'glue:GetDatabase',
          'glue:GetDatabases',
          'glue:GetTable',
          'glue:GetTables',
          'glue:UpdateTable',
        ],
        resources: [
          `arn:aws:glue:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:catalog`,
          `arn:aws:glue:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:catalog/s3tablescatalog`,
          `arn:aws:glue:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:catalog/s3tablescatalog/${config.s3Tables.tableBucketName}`,
          `arn:aws:glue:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:database/*`,
          `arn:aws:glue:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/*/*`,
        ],
      }),
    );
    // 汎用バケットへは firehose-errors/ への失敗レコード退避のみ。
    this.bucket.grantReadWrite(firehoseRole, 'firehose-errors/*');
    firehoseRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['logs:PutLogEvents'],
        resources: [firehoseLogGroup.logGroupArn],
      }),
    );

    this.deliveryStream = new firehose.CfnDeliveryStream(this, 'S3TablesDeliveryStream', {
      deliveryStreamName: config.firehose.deliveryStreamName,
      deliveryStreamType: 'DirectPut',
      deliveryStreamEncryptionConfigurationInput: {
        keyType: 'AWS_OWNED_CMK',
      },
      icebergDestinationConfiguration: {
        roleArn: firehoseRole.roleArn,
        catalogConfiguration: {
          catalogArn: `arn:aws:glue:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:catalog/s3tablescatalog/${config.s3Tables.tableBucketName}`,
        },
        // S3 Tables の namespace が Glue の database に相当する。
        destinationTableConfigurationList: [
          {
            destinationDatabaseName: config.s3Tables.namespace,
            destinationTableName: config.s3Tables.tableName,
          },
        ],
        // insert-only のログ用途なので append-only (行更新の CDC 経路を持たない)。
        appendOnly: true,
        bufferingHints: {
          intervalInSeconds: config.firehose.bufferIntervalSeconds,
          sizeInMBs: 64,
        },
        s3BackupMode: 'FailedDataOnly',
        s3Configuration: {
          bucketArn: this.bucket.bucketArn,
          roleArn: firehoseRole.roleArn,
          errorOutputPrefix: 'firehose-errors/',
        },
        cloudWatchLoggingOptions: {
          enabled: true,
          logGroupName: firehoseLogGroup.logGroupName,
          logStreamName: firehoseLogStream.logStreamName,
        },
      },
    });
    this.deliveryStream.node.addDependency(logsS3Table);
    this.deliveryStream.node.addDependency(s3TablesCatalog);
    // CfnDeliveryStream は roleArn の文字列参照だけでは Policy リソースへの依存が
    // 張られず、権限が付く前に Firehose の作成時検証が走って失敗しうる。
    const firehoseRoleDefaultPolicy = firehoseRole.node.tryFindChild('DefaultPolicy');
    if (firehoseRoleDefaultPolicy !== undefined) {
      this.deliveryStream.node.addDependency(firehoseRoleDefaultPolicy);
    }

    // ---- Athena WorkGroup ----
    const workGroup = new athena.CfnWorkGroup(this, 'WorkGroup', {
      name: config.athena.workGroupName,
      recursiveDeleteOption: true,
      workGroupConfiguration: {
        enforceWorkGroupConfiguration: true,
        publishCloudWatchMetricsEnabled: true,
        engineVersion: {
          selectedEngineVersion: 'Athena engine version 3',
        },
        resultConfiguration: {
          outputLocation: `s3://${this.bucket.bucketName}/athena-results/`,
          encryptionConfiguration: {
            encryptionOption: 'SSE_S3',
          },
        },
      },
    });

    // ---- Athena Named Queries (よく使う検索の登録) ----
    // いずれも実データに対して実行確認済み (2026-07-11)。
    // ECS ヘルスチェック (nc -z, 127.0.0.1 から 30 秒ごと) が squid_access の
    // ノイズ行になるため、client_ip でヘルスチェックを除外するのが基本形。
    // forwarder 行は client_ip が NULL のため IS DISTINCT FROM で残す。
    // ts は UTC (ISO8601) で保存しているため、表示は JST に変換して返す。
    //
    // NamedQuery には catalog を指定するプロパティがないため、S3 Tables の
    // federated catalog は FROM 句で完全修飾する。
    const logsTableRef = `"s3tablescatalog/${config.s3Tables.tableBucketName}"."${config.s3Tables.namespace}"."${config.s3Tables.tableName}"`;
    const tsJst =
      "format_datetime(from_iso8601_timestamp(ts) AT TIME ZONE 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss')";
    const namedQueries: { id: string; name: string; description: string; sql: string }[] = [
      {
        id: 'RecentActivityQuery',
        name: 'recent-activity',
        description:
          '直近のアクティビティ (squid アクセス + forwarder イベント)。ECS ヘルスチェックのノイズを除外。時刻は JST',
        sql: [
          `SELECT ${tsJst} AS ts_jst,`,
          '       log_type,',
          "       coalesce(message, method || ' ' || url) AS event,",
          '       status, duration_ms, bytes_in, bytes_out',
          `FROM ${logsTableRef}`,
          "WHERE client_ip IS DISTINCT FROM '127.0.0.1'",
          'ORDER BY ts DESC',
          'LIMIT 100',
        ].join('\n'),
      },
      {
        id: 'DestinationSummaryQuery',
        name: 'destination-summary-7d',
        description:
          '直近7日の外部通信の宛先別サマリ (egress 監査用)。想定外の宛先への phone-home 検知に使う。時刻は JST',
        sql: [
          'SELECT url AS destination,',
          '       count(*) AS requests,',
          '       count_if(status >= 400) AS errors,',
          '       sum(bytes_in) AS bytes_in,',
          '       sum(bytes_out) AS bytes_out,',
          '       round(avg(duration_ms)) AS avg_ms,',
          "       format_datetime(from_iso8601_timestamp(max(ts)) AT TIME ZONE 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss') AS last_seen_jst",
          `FROM ${logsTableRef}`,
          "WHERE log_type = 'squid_access'",
          "  AND client_ip <> '127.0.0.1'",
          "  AND from_iso8601_timestamp(ts) > current_timestamp - interval '7' day",
          'GROUP BY url',
          'ORDER BY requests DESC',
          'LIMIT 50',
        ].join('\n'),
      },
      {
        id: 'DeniedOrErrorAccessQuery',
        name: 'denied-or-error-access',
        description:
          '拒否 (TCP_DENIED) と HTTP 4xx/5xx のアクセス検出。squid の egress 制限に引っかかった通信の調査用。時刻は JST',
        sql: [
          `SELECT ${tsJst} AS ts_jst,`,
          '       client_ip, method, url, status, squid_status, user_agent',
          `FROM ${logsTableRef}`,
          "WHERE log_type = 'squid_access'",
          "  AND client_ip <> '127.0.0.1'",
          "  AND (status >= 400 OR squid_status LIKE 'TCP_DENIED%')",
          'ORDER BY ts DESC',
          'LIMIT 100',
        ].join('\n'),
      },
    ];
    for (const q of namedQueries) {
      const namedQuery = new athena.CfnNamedQuery(this, q.id, {
        name: q.name,
        description: q.description,
        database: config.s3Tables.namespace,
        workGroup: config.athena.workGroupName,
        queryString: q.sql,
      });
      // workGroup プロパティは名前の文字列参照のため、依存を明示する。
      namedQuery.addDependency(workGroup);
    }

    // ---- 既存 tidb-proxy タスクロールへの権限後付け ----
    // FireLens の kinesis_firehose / cloudwatch_logs 出力プラグインと init
    // プロセスの S3 設定取得は、Execution Role ではなくタスクロールの資格情報
    // (コンテナメタデータ経由) で AWS API を呼ぶ。
    const taskRoleArn = ssm.StringParameter.valueForStringParameter(
      this,
      config.ssm.proxy.taskRole,
    );
    const taskRole = iam.Role.fromRoleArn(this, 'ImportedTidbProxyTaskRole', taskRoleArn, {
      mutable: true,
    });
    const proxyLogGroupName = ssm.StringParameter.valueForStringParameter(
      this,
      config.ssm.proxy.logGroupName,
    );

    taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['firehose:PutRecordBatch'],
        resources: [this.deliveryStream.attrArn],
      }),
    );
    taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['s3:GetObject'],
        resources: [this.bucket.arnForObjects('firelens-config/*')],
      }),
    );
    taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['s3:GetBucketLocation'],
        resources: [this.bucket.bucketArn],
      }),
    );
    taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['logs:CreateLogStream', 'logs:DescribeLogStreams', 'logs:PutLogEvents'],
        resources: [
          `arn:aws:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:${proxyLogGroupName}:*`,
        ],
      }),
    );

    // ---- SSM Parameters (ecspresso が参照) ----
    new ssm.StringParameter(this, 'DeliveryStreamNameParam', {
      parameterName: config.ssm.logs.deliveryStreamName,
      stringValue: config.firehose.deliveryStreamName,
    });
    new ssm.StringParameter(this, 'FirelensConfigS3ArnPrefixParam', {
      parameterName: config.ssm.logs.firelensConfigS3ArnPrefix,
      stringValue: `${this.bucket.bucketArn}/firelens-config`,
    });
  }
}
