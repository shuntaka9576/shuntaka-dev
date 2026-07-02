import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

// CDK はインフラのスキャフォールド (cluster / ECR / IAM / LogGroup / SG / Cloud Map /
// SSM Params) のみを作る。Task Definition と Service は ecspresso 側の責務。
// task 文書 (docs/source/tasks/2026-06-29-blog-api-tidb-proxy.md) の責任分界に従う。
export class TidbProxyConstruct extends Construct {
  public readonly cluster: ecs.ICluster;
  public readonly ecrRepository: ecr.IRepository;
  public readonly taskRole: iam.IRole;
  public readonly executionRole: iam.IRole;
  public readonly securityGroup: ec2.ISecurityGroup;
  public readonly logGroup: logs.ILogGroup;
  public readonly cloudMapNamespace: servicediscovery.PrivateDnsNamespace;
  public readonly cloudMapService: servicediscovery.IService;

  constructor(
    scope: Construct,
    id: string,
    props: {
      projectName: string;
      vpc: ec2.IVpc;
      tailscale: {
        proxyAuthKey: string;
      };
      ssm: {
        proxy: {
          clusterName: string;
          ecrRepositoryUri: string;
          taskRole: string;
          taskExecRole: string;
          sgId: string;
          logGroupName: string;
          cloudMapNamespaceId: string;
          cloudMapServiceArn: string;
          serviceName: string;
        };
      };
    },
  ) {
    super(scope, id);

    // ---- ECR Repository ----
    // lifecycle で常に最新 1 image のみ保持。古い image を残しても rollback には
    // ecspresso rollback で task def の image tag を戻す方が安全なので、ECR には
    // 1 個だけあればよい。コストもほぼゼロに。
    this.ecrRepository = new ecr.Repository(this, 'EcrRepository', {
      repositoryName: props.projectName,
      imageScanOnPush: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
      lifecycleRules: [
        {
          description: 'Keep only the latest 1 image',
          maxImageCount: 1,
          rulePriority: 1,
        },
      ],
    });

    // ---- ECS Cluster ----
    this.cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: props.projectName,
      vpc: props.vpc,
      enableFargateCapacityProviders: true,
    });

    // ---- IAM Roles ----
    this.taskRole = new iam.Role(this, 'TaskRole', {
      roleName: `${props.projectName}-task`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    this.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ecs:UpdateTaskProtection'],
        resources: ['*'],
      }),
    );
    this.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'ssmmessages:CreateControlChannel',
          'ssmmessages:CreateDataChannel',
          'ssmmessages:OpenControlChannel',
          'ssmmessages:OpenDataChannel',
        ],
        resources: ['*'],
      }),
    );

    this.executionRole = new iam.Role(this, 'ExecutionRole', {
      roleName: `${props.projectName}-exec`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });
    // ecspresso task def の `secrets[].valueFrom` で Tailscale auth key を SSM
    // から runtime fetch するため、ExecutionRole に GetParameters 権限を与える。
    // SecureString のため kms:Decrypt も必要 (default alias/aws/ssm)。
    this.executionRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ssm:GetParameters'],
        resources: [
          `arn:aws:ssm:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:parameter${props.tailscale.proxyAuthKey}`,
        ],
      }),
    );
    this.executionRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['kms:Decrypt'],
        resources: [`arn:aws:kms:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:alias/aws/ssm`],
      }),
    );

    // ---- CloudWatch Log Group ----
    this.logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: `/ecs/${props.projectName}`,
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ---- OTel Collector sidecar (observability) ----
    // ecspresso task def の otel-collector が awsemf exporter で EMF ログを書く先。
    // メトリクスは EMF から抽出されるためログ自体の保持は短くてよい。
    const otelEmfLogGroup = new logs.LogGroup(this, 'OtelEmfLogGroup', {
      logGroupName: '/aws/otel/blog-runtime',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // awsxray exporter 用。X-Ray API はリソースレベル制限非対応のため Resource:*。
    this.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'xray:PutTraceSegments',
          'xray:PutTelemetryRecords',
          'xray:GetSamplingRules',
          'xray:GetSamplingTargets',
          'xray:GetSamplingStatisticsSummaries',
        ],
        resources: ['*'],
      }),
    );

    // awsemf exporter 用。logGroupArn は `:*` 付きで stream も包含する。
    this.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'logs:CreateLogGroup',
          'logs:CreateLogStream',
          'logs:PutLogEvents',
          'logs:PutRetentionPolicy',
          'logs:DescribeLogGroups',
          'logs:DescribeLogStreams',
        ],
        resources: [otelEmfLogGroup.logGroupArn],
      }),
    );

    // ---- Security Group ----
    // inbound rule の追加は Lambda stack (タスク 4 / 6) 側で SecurityGroup.fromSecurityGroupId
    // で参照して `addIngressRule` する。ここでは空で作る。
    // outbound: 全許可 (Tailscale control plane HTTPS / WireGuard UDP / ECR / Logs)。
    this.securityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', {
      vpc: props.vpc,
      securityGroupName: `${props.projectName}-sg`,
      description: 'tidb-proxy Fargate task SG (inbound from lambda SGs added per stage)',
      allowAllOutbound: true,
    });

    // ---- Cloud Map (private DNS) ----
    // VPC 内 Lambda は `tidb-proxy.internal` で proxy にアクセスする。
    // ecspresso service def の serviceRegistries に CloudMap service の ARN を
    // 指定するため、ARN を SSM に出力する。
    this.cloudMapNamespace = new servicediscovery.PrivateDnsNamespace(this, 'CloudMapNamespace', {
      name: 'internal',
      vpc: props.vpc,
    });
    this.cloudMapService = this.cloudMapNamespace.createService('CloudMapService', {
      name: props.projectName,
      dnsRecordType: servicediscovery.DnsRecordType.A,
      dnsTtl: cdk.Duration.seconds(10),
      // ecspresso の awsvpc task は IP-based instance を登録するので healthCheck は
      // ECS のヘルスチェック (task healthCheck) 側で担保する。
      customHealthCheck: { failureThreshold: 1 },
    });

    // ---- SSM Parameters ----
    new ssm.StringParameter(this, 'EcrRepositoryUriParam', {
      parameterName: props.ssm.proxy.ecrRepositoryUri,
      stringValue: this.ecrRepository.repositoryUri,
    });
    new ssm.StringParameter(this, 'ClusterNameParam', {
      parameterName: props.ssm.proxy.clusterName,
      stringValue: this.cluster.clusterName,
    });
    new ssm.StringParameter(this, 'TaskRoleParam', {
      parameterName: props.ssm.proxy.taskRole,
      stringValue: this.taskRole.roleArn,
    });
    new ssm.StringParameter(this, 'TaskExecRoleParam', {
      parameterName: props.ssm.proxy.taskExecRole,
      stringValue: this.executionRole.roleArn,
    });
    new ssm.StringParameter(this, 'SgIdParam', {
      parameterName: props.ssm.proxy.sgId,
      stringValue: this.securityGroup.securityGroupId,
    });
    new ssm.StringParameter(this, 'LogGroupNameParam', {
      parameterName: props.ssm.proxy.logGroupName,
      stringValue: this.logGroup.logGroupName,
    });
    new ssm.StringParameter(this, 'CloudMapNamespaceIdParam', {
      parameterName: props.ssm.proxy.cloudMapNamespaceId,
      stringValue: this.cloudMapNamespace.namespaceId,
    });
    new ssm.StringParameter(this, 'CloudMapServiceArnParam', {
      parameterName: props.ssm.proxy.cloudMapServiceArn,
      stringValue: this.cloudMapService.serviceArn,
    });
    new ssm.StringParameter(this, 'ServiceNameParam', {
      parameterName: props.ssm.proxy.serviceName,
      stringValue: props.projectName,
    });
  }
}
