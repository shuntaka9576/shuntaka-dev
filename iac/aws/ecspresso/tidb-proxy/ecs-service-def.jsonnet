local ssmParams = import 'ssm-params.jsonnet';

{
  desiredCount: 1,
  capacityProviderStrategy: [
    { capacityProvider: 'FARGATE_SPOT', weight: 1 },
  ],
  networkConfiguration: {
    awsvpcConfiguration: {
      assignPublicIp: 'ENABLED',
      securityGroups: [ssmParams.ssm.proxy.sgId],
      subnets: [ssmParams.ssm.vpc.publicSubnetId1],
    },
  },
  serviceRegistries: [
    { registryArn: ssmParams.ssm.proxy.cloudMapServiceArn },
  ],
  deploymentConfiguration: {
    deploymentCircuitBreaker: { enable: true, rollback: true },
    maximumPercent: 200,
    minimumHealthyPercent: 0,
    strategy: 'ROLLING',
  },
  deploymentController: { type: 'ECS' },
  enableECSManagedTags: false,
  enableExecuteCommand: true,
  platformFamily: 'Linux',
  platformVersion: 'LATEST',
  propagateTags: 'NONE',
  schedulingStrategy: 'REPLICA',
}
