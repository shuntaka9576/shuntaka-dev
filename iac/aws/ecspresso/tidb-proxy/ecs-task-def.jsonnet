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
  ],
}
