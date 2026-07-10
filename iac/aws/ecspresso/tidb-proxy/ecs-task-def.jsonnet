local imageTag = import 'image-tag.jsonnet';
local ssmParams = import 'ssm-params.jsonnet';

{
  family: 'tidb-proxy',
  cpu: '256',
  memory: '512',
  networkMode: 'awsvpc',
  requiresCompatibilities: ['FARGATE'],
  runtimePlatform: {
    cpuArchitecture: 'ARM64',
    operatingSystemFamily: 'LINUX',
  },
  taskRoleArn: ssmParams.ssm.proxy.taskRole,
  executionRoleArn: ssmParams.ssm.proxy.taskExecRole,
  containerDefinitions: [
    {
      name: 'tidb-proxy',
      image: ssmParams.ssm.proxy.ecrRepositoryUri + ':' + imageTag.tag,
      essential: true,
      environment: [
        { name: 'TAILNET_SUFFIX', value: ssmParams.ssm.tailscale.tailnetSuffix },
        { name: 'TIDB_HOSTNAME', value: 'tidb' },
        { name: 'TIDB_PORT', value: '4000' },
        // 同一 task 内 (awsvpc は network namespace 共有) の otel-collector へ送る
        { name: 'OTEL_EXPORTER_OTLP_ENDPOINT', value: 'http://localhost:4317' },
        { name: 'OTEL_SERVICE_NAME', value: 'tidb-proxy' },
      ],
      secrets: [
        {
          name: 'TS_AUTHKEY',
          valueFrom: ssmParams.ssm.tailscale.proxyAuthKeyParamName,
        },
      ],
      portMappings: [
        { containerPort: 13306, protocol: 'tcp' },
        { containerPort: 3128, protocol: 'tcp' },
      ],
      healthCheck: {
        command: [
          'CMD-SHELL',
          'nc -z localhost 13306 && nc -z localhost 3128',
        ],
        interval: 30,
        timeout: 5,
        retries: 3,
        startPeriod: 60,
      },
      stopTimeout: 30,
      // stdout/stderr を log-router (FireLens) に流し、level で CloudWatch Logs /
      // Firehose (Iceberg) に振り分ける。設計は
      // docs/source/98_tasks/2026-07-10-tidb-proxy-log-iceberg/index.md を参照。
      logConfiguration: {
        logDriver: 'awsfirelens',
      },
      dependsOn: [
        { containerName: 'log-router', condition: 'START' },
      ],
      readonlyRootFilesystem: false,
    },
    {
      // FireLens (Fluent Bit) ログルーター。init タグイメージが起動時に S3 から
      // Fluent Bit 設定 (apps/tidb-proxy/firelens/) を取得する。設定変更の反映は
      // S3 更新 (cdk deploy st-tidb-proxy-logs) 後に force-new-deployment が必要。
      // essential: true — ログ配送が死んだら task ごと再起動させる (entrypoint.sh
      // が squid / forwarder を tini で相互監視するのと同じ思想)。
      name: 'log-router',
      image: 'public.ecr.aws/aws-observability/aws-for-fluent-bit:init-2.34.3',
      essential: true,
      firelensConfiguration: {
        type: 'fluentbit',
      },
      environment: [
        {
          name: 'aws_fluent_bit_init_s3_1',
          value: ssmParams.ssm.logs.firelensConfigS3ArnPrefix + '/extra.conf',
        },
        {
          name: 'aws_fluent_bit_init_s3_2',
          value: ssmParams.ssm.logs.firelensConfigS3ArnPrefix + '/parsers.conf',
        },
        // extra.conf 内の ${AWS_REGION} / ${CW_LOG_GROUP_NAME} /
        // ${FIREHOSE_DELIVERY_STREAM} を展開するための値。
        { name: 'AWS_REGION', value: ssmParams.region },
        { name: 'CW_LOG_GROUP_NAME', value: ssmParams.ssm.proxy.logGroupName },
        { name: 'FIREHOSE_DELIVERY_STREAM', value: ssmParams.ssm.logs.deliveryStreamName },
      ],
      // log-router 自身のログ (init の S3 取得失敗や設定エラーの調査用) は awslogs へ。
      logConfiguration: {
        logDriver: 'awslogs',
        options: {
          'awslogs-group': ssmParams.ssm.proxy.logGroupName,
          'awslogs-region': ssmParams.region,
          'awslogs-stream-prefix': 'log-router',
        },
      },
      readonlyRootFilesystem: false,
    },
    {
      // ADOT Collector sidecar。Lambda / forwarder からの OTLP を受けて
      // X-Ray / CloudWatch EMF へ export する。
      // essential: false で collector が死んでも production 経路 (tidb-proxy)
      // には影響させない (telemetry は途切れる)。
      name: 'otel-collector',
      image: 'public.ecr.aws/aws-observability/aws-otel-collector:v0.48.0',
      essential: false,
      environment: [
        { name: 'AOT_CONFIG_CONTENT', value: importstr 'otel-config.yaml' },
      ],
      portMappings: [
        { containerPort: 4317, protocol: 'tcp' },
        { containerPort: 4318, protocol: 'tcp' },
      ],
      healthCheck: {
        // health_check extension (13133) を叩く ADOT 同梱バイナリ
        command: ['CMD', '/healthcheck'],
        interval: 30,
        timeout: 5,
        retries: 3,
        startPeriod: 10,
      },
      stopTimeout: 10,
      logConfiguration: {
        logDriver: 'awslogs',
        options: {
          'awslogs-group': ssmParams.ssm.proxy.logGroupName,
          'awslogs-region': ssmParams.region,
          'awslogs-stream-prefix': 'otel-collector',
        },
      },
      readonlyRootFilesystem: false,
    },
  ],
}
