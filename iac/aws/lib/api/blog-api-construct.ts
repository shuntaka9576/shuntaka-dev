import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { WebFunction } from '../web-function.js';
import { blogApiWebFunctionCode } from '../web-function-package.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// blog-api は同じ Rust のコードを 2 つの関数で動かす。
// - Web Function: HTTP をすべて受ける (CloudFront の /api/* から OAC 経由)。GitHub webhook は
//   署名を検証したら Event Function へ Event invoke して即座に 200 を返す
// - Event Function: Event invoke のペイロードを LWA が POST /events へ転送し、webhook の実処理
//   (全記事スキャン / lab 同期) を行う。Web Functions は HTTP しか受けられないため残す
export class BlogAPIConstruct extends Construct {
  /** Event Function 実行ロールの ARN。AdminStack が lab 画像バケットへの権限付与に使う */
  public readonly webApiLambdaRoleArn: string;
  public readonly webFunction: WebFunction;

  constructor(
    scope: Construct,
    id: string,
    props: {
      physicalPrefix: string;
      stageName: string;
      /** moments 画像の配信ベース URL（例: https://images.shuntaka.dev） */
      imagesBaseUrl: string;
      /** lab 章コンテンツの GitHub リポジトリ (例: shuntaka9576/lab-contents-dev) */
      labRepoFullName: string;
      /** lab 画像バケットの物理名 (AdminStack 所有。S3 権限は AdminStack 側で付与) */
      labImagesBucketName: string;
      databaseName: string;
      webFunctionCodeBucket: s3.Bucket;
      /** Web Function の endpoint が使える実行環境の上限 */
      webFunctionMaxEnvironments: number;
      ssmParameters: {
        proxy: {
          vpcId: string;
          privateSubnetId1: string;
          privateSubnetId2: string;
          sgId: string;
        };
      };
      blogApiEnv: {
        githubAppId: string;
        githubAppSecretPemKeyName: string;
        githubWebhookSecretKeyName: string;
        cloudinaryCloudName: string;
        cloudinaryApiKey: string;
        cloudinaryApiSecretKeyName: string;
      };
      observability: {
        // OTel resource の service.name。ObservabilityConstruct の dashboard
        // dimension と一致させるため main-stack 側で一元的に決める。
        otelServiceName: string;
      };
    },
  ) {
    super(scope, id);

    const proxyVpcId = ssm.StringParameter.valueForStringParameter(
      this,
      props.ssmParameters.proxy.vpcId,
    );
    const proxyPrivateSubnetId = ssm.StringParameter.valueForStringParameter(
      this,
      props.ssmParameters.proxy.privateSubnetId1,
    );
    const proxyPrivateSubnetId2 = ssm.StringParameter.valueForStringParameter(
      this,
      props.ssmParameters.proxy.privateSubnetId2,
    );
    const proxySgId = ssm.StringParameter.valueForStringParameter(
      this,
      props.ssmParameters.proxy.sgId,
    );

    const proxyVpc = ec2.Vpc.fromVpcAttributes(this, 'ImportedProxyVpc', {
      vpcId: proxyVpcId,
      availabilityZones: ['ap-northeast-1a'],
      isolatedSubnetIds: [proxyPrivateSubnetId],
    });
    const proxyPrivateSubnet = ec2.Subnet.fromSubnetId(
      this,
      'ImportedProxyPrivateSubnet',
      proxyPrivateSubnetId,
    );
    const proxySecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      'ImportedProxySg',
      proxySgId,
    );

    // Event Function の ENI と Web Function の network connector の ENI で共有する
    const lambdaSg = new ec2.SecurityGroup(this, 'LambdaSg', {
      vpc: proxyVpc,
      securityGroupName: `lambda-sg-${props.stageName}`,
      description: `blog-api lambda SG for ${props.stageName}`,
      allowAllOutbound: false,
    });
    lambdaSg.addEgressRule(proxySecurityGroup, ec2.Port.tcp(13306), 'mysql via tidb-proxy');
    lambdaSg.addEgressRule(proxySecurityGroup, ec2.Port.tcp(3128), 'https via tidb-proxy');
    lambdaSg.addEgressRule(
      proxySecurityGroup,
      ec2.Port.tcp(18080),
      'plamo embedding via tidb-proxy',
    );
    lambdaSg.addEgressRule(
      proxySecurityGroup,
      ec2.Port.tcp(4318),
      'otlp http to adot collector sidecar',
    );

    proxySecurityGroup.addIngressRule(
      lambdaSg,
      ec2.Port.tcp(13306),
      `mysql from lambda-sg-${props.stageName}`,
    );
    proxySecurityGroup.addIngressRule(
      lambdaSg,
      ec2.Port.tcp(3128),
      `https from lambda-sg-${props.stageName}`,
    );
    proxySecurityGroup.addIngressRule(
      lambdaSg,
      ec2.Port.tcp(18080),
      `plamo embedding from lambda-sg-${props.stageName}`,
    );
    proxySecurityGroup.addIngressRule(
      lambdaSg,
      ec2.Port.tcp(4318),
      `otlp from lambda-sg-${props.stageName}`,
    );

    const proxyDnsName = 'tidb-proxy.internal';
    const proxyHttpUrl = `http://${proxyDnsName}:3128`;

    // CFN は Lambda env var に ssm-secure dynamic reference をサポートしないため、
    // AwsCustomResource (deploy-time に Lambda が GetParameter する) 経由で取り出す。
    const lookupSecureString = (id: string, parameterName: string): string => {
      const lookup = new cr.AwsCustomResource(this, id, {
        onUpdate: {
          service: 'SSM',
          action: 'GetParameter',
          parameters: { Name: parameterName, WithDecryption: true },
          physicalResourceId: cr.PhysicalResourceId.of(parameterName),
        },
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ['ssm:GetParameter'],
            resources: [
              `arn:aws:ssm:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:parameter${parameterName}`,
            ],
          }),
          new iam.PolicyStatement({
            actions: ['kms:Decrypt'],
            resources: [`arn:aws:kms:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:alias/aws/ssm`],
          }),
        ]),
      });
      return lookup.getResponseField('Parameter.Value');
    };

    const ghAppSecretPem = lookupSecureString(
      'GhAppSecretLookup',
      props.blogApiEnv.githubAppSecretPemKeyName,
    );
    const ghWebhookSecret = lookupSecureString(
      'GhWebhookSecretLookup',
      props.blogApiEnv.githubWebhookSecretKeyName,
    );
    const cloudinaryApiSecret = lookupSecureString(
      'CloudinaryApiSecretLookup',
      props.blogApiEnv.cloudinaryApiSecretKeyName,
    );

    // 2 つの関数で共通のアプリ設定
    const apiEnvironment: Record<string, string> = {
      DATABASE_URL: `mysql://root@${proxyDnsName}:13306/${props.databaseName}?ssl-mode=PREFERRED`,
      HTTPS_PROXY: proxyHttpUrl,
      HTTP_PROXY: proxyHttpUrl,
      // OTLP 送信は squid を経由させず collector sidecar へ直接届ける
      NO_PROXY: `169.254.169.254,localhost,127.0.0.1,${proxyDnsName}`,
      // PLaMo Embedding Service へは tidb-proxy の tsnet forwarder (18080) 経由。
      // host が proxyDnsName なので上の NO_PROXY に載り、squid (3128) を経由せず直行する。
      PLAMO_EMBED_ENDPOINT: `http://${proxyDnsName}:18080`,
      // tidb-proxy task 上の ADOT Collector sidecar (OTLP/HTTP)。
      // 未設定ならアプリ側で telemetry は無効化される。
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://${proxyDnsName}:4318`,
      OTEL_SERVICE_NAME: props.observability.otelServiceName,
      GH_APP_ID: props.blogApiEnv.githubAppId,
      GH_APP_SECRET_PEM: ghAppSecretPem,
      GH_WEBHOOK_SECRET: ghWebhookSecret,
      CLOUDINARY_CLOUD_NAME: props.blogApiEnv.cloudinaryCloudName,
      CLOUDINARY_API_KEY: props.blogApiEnv.cloudinaryApiKey,
      CLOUDINARY_API_SECRET: cloudinaryApiSecret,
      IMAGES_BASE_URL: props.imagesBaseUrl,
      LAB_REPO_FULL_NAME: props.labRepoFullName,
      LAB_IMAGES_BUCKET_NAME: props.labImagesBucketName,
    };

    // ---- Event Function (webhook の実処理) ----
    const eventFunction = new lambda.DockerImageFunction(this, 'WebApiLambda', {
      functionName: `${props.physicalPrefix}-blog-api`,
      code: lambda.DockerImageCode.fromImageAsset(path.resolve(__dirname, '../../../..')),
      memorySize: 1024,
      timeout: cdk.Duration.seconds(15 * 60),
      architecture: lambda.Architecture.ARM_64,
      loggingFormat: lambda.LoggingFormat.JSON,
      logGroup: new logs.LogGroup(this, 'BlogApiLogGroup', {
        logGroupName: `/aws/lambda/${props.physicalPrefix}-blog-api`,
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      vpc: proxyVpc,
      vpcSubnets: { subnets: [proxyPrivateSubnet] },
      securityGroups: [lambdaSg],
      environment: {
        ...apiEnvironment,
        // Web Function からの Event invoke のペイロードを LWA がアプリの POST /events へ転送する
        // （デフォルト値だが挙動を明示するため宣言）
        AWS_LWA_PASS_THROUGH_PATH: '/events',
      },
    });

    eventFunction.role?.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
    );

    // lab 画像バケットへの S3 権限はここでは付与しない。バケットは AdminStack 所有
    // (CloudFront OAC のポリシー書き戻しで循環依存になるため) のため、
    // AdminStack 側でこのロール ARN を受け取って iam.Policy をアタッチする。
    this.webApiLambdaRoleArn = eventFunction.role!.roleArn;

    // ---- Web Function の VPC 出口 (egress network connector) ----
    // Web Function は VPC の外 (Lambda 管理のインフラ) で動くため、tidb-proxy の
    // プライベート IP へは connector の ENI を経由する。connector はインターネットへの
    // 出口を持たないので、外向き HTTPS は Event Function と同じく squid (HTTPS_PROXY) を通す
    const connectorOperatorRole = new iam.Role(this, 'NetworkConnectorOperatorRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        ManageEni: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['ec2:CreateNetworkInterface'],
              resources: [
                `arn:${cdk.Aws.PARTITION}:ec2:*:*:network-interface/*`,
                `arn:${cdk.Aws.PARTITION}:ec2:*:*:subnet/*`,
                `arn:${cdk.Aws.PARTITION}:ec2:*:*:security-group/*`,
              ],
            }),
            new iam.PolicyStatement({
              actions: ['ec2:CreateTags'],
              resources: [`arn:${cdk.Aws.PARTITION}:ec2:*:*:network-interface/*`],
              conditions: {
                StringEquals: {
                  'ec2:ManagedResourceOperator': 'network-connectors.lambda.amazonaws.com',
                },
              },
            }),
          ],
        }),
      },
    });

    const networkConnector = new lambda.CfnNetworkConnector(this, 'NetworkConnector', {
      name: `${props.physicalPrefix}-blog-api`,
      operatorRole: connectorOperatorRole.roleArn,
      configuration: {
        vpcEgressConfiguration: {
          // 別 AZ のサブネットが 2 つ以上必要。tidb-proxy は 1a にあるため、1c の ENI を通る分は AZ 間通信になる
          subnetIds: [proxyPrivateSubnetId, proxyPrivateSubnetId2],
          securityGroupIds: [lambdaSg.securityGroupId],
          networkProtocol: 'IPv4',
          associatedComputeResourceTypes: ['WebFunction'],
        },
      },
    });
    // CDK 同梱の CloudFormation 検証用 schema が古く、許容値に WebFunction が無い (MicroVm のみ)
    cdk.Validations.of(networkConnector).acknowledge({
      id: 'CloudFormation-Validate::W3030',
      reason: 'AssociatedComputeResourceTypes の WebFunction は検証用 schema に未収録',
    });

    // ---- Web Function (HTTP 全般) ----
    this.webFunction = new WebFunction(this, 'WebFunction', {
      functionName: `${props.physicalPrefix}-blog-api-web`,
      codeBucket: props.webFunctionCodeBucket,
      code: blogApiWebFunctionCode(),
      timeoutSeconds: 30,
      maxEnvironments: props.webFunctionMaxEnvironments,
      egressNetworkConnectorArn: networkConnector.attrLatestVersionArn,
      environment: {
        ...apiEnvironment,
        // webhook の実処理を逃がす先。経路は squid (HTTPS_PROXY) の CONNECT トンネル経由で Lambda API に到達する
        EVENT_FUNCTION_NAME: eventFunction.functionName,
      },
    });
    eventFunction.grantInvoke(this.webFunction.role);
  }
}
