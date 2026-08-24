import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as athena from 'aws-cdk-lib/aws-athena';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as firehose from 'aws-cdk-lib/aws-kinesisfirehose';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as sfnTasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';
import { type LogAnalyticsParameter } from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// tidb-proxy のログ分析基盤。FireLens (Fluent Bit) が振り分けた INFO 系ログを
// Firehose 経由で S3 上の Iceberg テーブルに蓄積し、Athena で検索する。
// 設計は docs/source/98_tasks/2026-07-10-tidb-proxy-log-iceberg/index.md を参照。
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

    // ---- S3 Bucket ----
    // prefix で用途を分離する:
    //   iceberg/         Iceberg テーブル本体。lifecycle rule は設定しない
    //                    (Iceberg のマニフェストが参照するファイルを S3 側で
    //                    blind に消すとメタデータ整合性が壊れるため。削減が
    //                    必要になったら Athena の OPTIMIZE / VACUUM を先に実行)
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

    // ---- Glue Database + Iceberg Table ----
    const glueDatabase = new glue.CfnDatabase(this, 'GlueDatabase', {
      catalogId: cdk.Aws.ACCOUNT_ID,
      databaseInput: {
        name: config.glue.databaseName,
      },
    });

    // スキーマは apps/tidb-proxy/firelens/extra.conf の Allowlist_key と揃える。
    // ts は Iceberg の timestamp 型ではなく string (ISO8601) にする。Firehose の
    // JSON -> timestamp 変換フォーマット要求に依存しないためで、Athena では
    // from_iso8601_timestamp(ts) で時刻演算する。パーティションは量が増えるまで
    // 持たない。
    //
    // Iceberg テーブルのメタデータは TableInput (Hive 形式) 側に書き、IcebergInput
    // は MetadataOperation: CREATE のみとする。TableInput は CFN 上必須のため、
    // icebergTableInput (Iceberg ネイティブスキーマ形式) と併用すると Glue の
    // リソースハンドラが "Table metadata is expected only via TableInput or via
    // IcebergTableInputProperties" で CREATE_FAILED になる (2026-07-11 の
    // st-tidb-proxy-logs 初回デプロイで確認)。
    const glueTable = new glue.CfnTable(this, 'LogsTable', {
      catalogId: cdk.Aws.ACCOUNT_ID,
      databaseName: config.glue.databaseName,
      tableInput: {
        name: config.glue.tableName,
        tableType: 'EXTERNAL_TABLE',
        storageDescriptor: {
          location: `s3://${this.bucket.bucketName}/iceberg/${config.glue.tableName}`,
          columns: [
            { name: 'ts', type: 'string' },
            { name: 'log_type', type: 'string' },
            { name: 'level', type: 'string' },
            { name: 'message', type: 'string' },
            { name: 'client_ip', type: 'string' },
            { name: 'method', type: 'string' },
            { name: 'url', type: 'string' },
            { name: 'http_version', type: 'string' },
            { name: 'status', type: 'int' },
            { name: 'bytes_in', type: 'bigint' },
            { name: 'bytes_out', type: 'bigint' },
            { name: 'duration_ms', type: 'bigint' },
            { name: 'user_agent', type: 'string' },
            { name: 'squid_status', type: 'string' },
            { name: 'hier_status', type: 'string' },
          ],
        },
      },
      openTableFormatInput: {
        icebergInput: {
          metadataOperation: 'CREATE',
          version: '2',
        },
      },
    });
    glueTable.addDependency(glueDatabase);

    // ---- Firehose (Direct PUT -> Iceberg) ----
    const firehoseLogGroup = new logs.LogGroup(this, 'FirehoseLogGroup', {
      logGroupName: `/aws/kinesisfirehose/${config.firehose.deliveryStreamName}`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const firehoseLogStream = new logs.LogStream(this, 'FirehoseLogStream', {
      logGroup: firehoseLogGroup,
      logStreamName: 'iceberg-delivery',
    });

    const firehoseRole = new iam.Role(this, 'FirehoseRole', {
      roleName: `${config.projectName}-firehose`,
      assumedBy: new iam.ServicePrincipal('firehose.amazonaws.com'),
    });
    firehoseRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['glue:GetDatabase', 'glue:GetTable', 'glue:GetTableVersions', 'glue:UpdateTable'],
        resources: [
          `arn:aws:glue:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:catalog`,
          `arn:aws:glue:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:database/${config.glue.databaseName}`,
          `arn:aws:glue:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/${config.glue.databaseName}/${config.glue.tableName}`,
        ],
      }),
    );
    // iceberg/ へのデータ書き込みと firehose-errors/ への失敗レコード退避の両方。
    this.bucket.grantReadWrite(firehoseRole);
    firehoseRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['logs:PutLogEvents'],
        resources: [firehoseLogGroup.logGroupArn],
      }),
    );

    this.deliveryStream = new firehose.CfnDeliveryStream(this, 'DeliveryStream', {
      deliveryStreamName: config.firehose.deliveryStreamName,
      deliveryStreamType: 'DirectPut',
      deliveryStreamEncryptionConfigurationInput: {
        keyType: 'AWS_OWNED_CMK',
      },
      icebergDestinationConfiguration: {
        roleArn: firehoseRole.roleArn,
        catalogConfiguration: {
          catalogArn: `arn:aws:glue:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:catalog`,
        },
        destinationTableConfigurationList: [
          {
            destinationDatabaseName: config.glue.databaseName,
            destinationTableName: config.glue.tableName,
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
    this.deliveryStream.node.addDependency(glueTable);
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

    // ---- Iceberg VACUUM maintenance ----
    // Athena の VACUUM は初回に 30 分を超える可能性があり、Lambda の最大実行時間
    // では完了待機できない。Step Functions の Athena .sync integration で query の
    // 成功 / 失敗まで追跡する。EventBridge Rule の有効 / 無効は config で管理する。
    const vacuumExecutionLogGroup = new logs.LogGroup(this, 'VacuumExecutionLogGroup', {
      // cspell:disable-next-line -- Step Functions 用 CloudWatch Logs の AWS 予約 prefix
      logGroupName: `/aws/vendedlogs/states/${config.projectName}-vacuum`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const vacuumQuery = new sfnTasks.AthenaStartQueryExecution(this, 'VacuumQuery', {
      integrationPattern: sfn.IntegrationPattern.RUN_JOB,
      queryString: `VACUUM ${config.glue.databaseName}.${config.glue.tableName}`,
      queryExecutionContext: {
        databaseName: config.glue.databaseName,
      },
      workGroup: config.athena.workGroupName,
      resultConfiguration: {
        outputLocation: {
          bucketName: this.bucket.bucketName,
          objectKey: 'athena-results/vacuum',
        },
      },
      taskTimeout: sfn.Timeout.duration(cdk.Duration.hours(5)),
    });
    const vacuumStateMachine = new sfn.StateMachine(this, 'VacuumStateMachine', {
      stateMachineName: `${config.projectName}-vacuum`,
      definitionBody: sfn.DefinitionBody.fromChainable(vacuumQuery),
      stateMachineType: sfn.StateMachineType.STANDARD,
      timeout: cdk.Duration.hours(5),
      logs: {
        destination: vacuumExecutionLogGroup,
        level: sfn.LogLevel.ALL,
        includeExecutionData: true,
      },
      tracingEnabled: true,
    });
    // AthenaStartQueryExecution の自動生成ポリシーには、VACUUM が commit する
    // Iceberg metadata への PutObject と、到達不能 files への DeleteObject が含まれない。
    // metadata の書き込み先は対象 table の prefix のみに絞る。
    vacuumStateMachine.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:PutObject'],
        resources: [this.bucket.arnForObjects('iceberg/logs/metadata/*')],
      }),
    );
    // 削除対象には metadata だけでなく data files も含まれ得るため、ログ専用 bucket
    // 全体への DeleteObject は維持する。
    this.bucket.grantDelete(vacuumStateMachine);
    vacuumStateMachine.node.addDependency(glueTable);
    vacuumStateMachine.node.addDependency(workGroup);

    new events.Rule(this, 'VacuumSchedule', {
      ruleName: `${config.projectName}-vacuum`,
      description: 'Run Athena VACUUM for the tidb-proxy Iceberg logs table',
      enabled: config.vacuum.scheduleEnabled,
      schedule: events.Schedule.expression(config.vacuum.scheduleExpression),
      targets: [
        new eventsTargets.SfnStateMachine(vacuumStateMachine, {
          retryAttempts: 0,
        }),
      ],
    });

    // ---- Athena Named Queries (よく使う検索の登録) ----
    // いずれも実データに対して実行確認済み (2026-07-11)。
    // ECS ヘルスチェック (nc -z, 127.0.0.1 から 30 秒ごと) が squid_access の
    // ノイズ行になるため、client_ip でヘルスチェックを除外するのが基本形。
    // forwarder 行は client_ip が NULL のため IS DISTINCT FROM で残す。
    // ts は UTC (ISO8601) で保存しているため、表示は JST に変換して返す。
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
          'FROM logs',
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
          'FROM logs',
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
          'FROM logs',
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
        database: config.glue.databaseName,
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
