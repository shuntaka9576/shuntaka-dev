local imageTag = import 'image-tag.jsonnet';
local ssmParams = import 'ssm-params.jsonnet';

{
  family: 'tidb-proxy',
  cpu: '256',
  // otel-collector sidecar (RSS ~100-200MB) 追加に伴い 512 -> 1024
  memory: '1024',
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
      logConfiguration: {
        logDriver: 'awslogs',
        options: {
          'awslogs-group': ssmParams.ssm.proxy.logGroupName,
          'awslogs-region': ssmParams.region,
          'awslogs-stream-prefix': ssmParams.serviceName,
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
