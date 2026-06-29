local projectName = 'tidb-proxy';

{
  serviceName: 'tidb-proxy',
  region: 'ap-northeast-1',

  ssm: {
    vpc: {
      publicSubnetId1: '{{ ssm `/' + projectName + '/vpc/public-subnet-id-1` }}',
    },
    proxy: {
      clusterName: '{{ ssm `/' + projectName + '/proxy/cluster-name` }}',
      ecrRepositoryUri: '{{ ssm `/' + projectName + '/proxy/ecr-repository-uri` }}',
      taskRole: '{{ ssm `/' + projectName + '/proxy/task-role` }}',
      taskExecRole: '{{ ssm `/' + projectName + '/proxy/task-exec-role` }}',
      sgId: '{{ ssm `/' + projectName + '/proxy/sg-id` }}',
      logGroupName: '{{ ssm `/' + projectName + '/proxy/log-group-name` }}',
      cloudMapServiceArn: '{{ ssm `/' + projectName + '/proxy/cloud-map-service-arn` }}',
    },
    tailscale: {
      proxyAuthKeyParamName: '/shared/shuntaka/tailscale/proxy-auth-key',
      tailnetSuffix: '{{ ssm `/shared/shuntaka/tailscale/tailnet-suffix` }}',
    },
  },
}
