import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import {
  type CfnMethod,
  EndpointType,
  LambdaIntegration,
  RestApi,
} from 'aws-cdk-lib/aws-apigateway';
import type * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class BlogAPIConstruct extends Construct {
  constructor(
    scope: Construct,
    id: string,
    props: {
      physicalPrefix: string;
      stageName: string;
      domain: string;
      /** moments 画像の配信ベース URL（例: https://images.shuntaka.dev） */
      imagesBaseUrl: string;
      hostedZone: route53.IHostedZone;
      certificate: acm.ICertificate;
      databaseName: string;
      ssmParameters: {
        apiGateway: {
          apiUrl: string;
        };
        proxy: {
          vpcId: string;
          privateSubnetId1: string;
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

    const webApiLambda = new lambda.DockerImageFunction(this, 'WebApiLambda', {
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
        AWS_LWA_INVOKE_MODE: 'response_stream',
        // 自己 Event invoke のペイロードを LWA がアプリの POST /events へ転送する
        // （デフォルト値だが挙動を明示するため宣言）。GitHub webhook の実処理を
        // 非同期化して GitHub 側の 10 秒配信タイムアウトを回避する
        AWS_LWA_PASS_THROUGH_PATH: '/events',
        DATABASE_URL: `mysql://root@${proxyDnsName}:13306/${props.databaseName}?ssl-mode=PREFERRED`,
        HTTPS_PROXY: proxyHttpUrl,
        HTTP_PROXY: proxyHttpUrl,
        // OTLP 送信は squid を経由させず collector sidecar へ直接届ける
        NO_PROXY: `169.254.169.254,localhost,127.0.0.1,${proxyDnsName}`,
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
      },
    });

    webApiLambda.role?.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
    );

    // webhook の実処理を自分自身へ Event invoke で逃がすための権限。
    // 経路は squid (HTTPS_PROXY) の CONNECT トンネル経由で Lambda API に到達する。
    // grantInvoke(自身) だと Function ⇔ DefaultPolicy の循環依存になるため、
    // 固定の物理関数名から ARN を組み立てて参照を切る
    webApiLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [
          cdk.Stack.of(this).formatArn({
            service: 'lambda',
            resource: 'function',
            resourceName: `${props.physicalPrefix}-blog-api`,
            arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
          }),
        ],
      }),
    );

    const restApi = new RestApi(this, 'RestApi', {
      restApiName: `${props.physicalPrefix}-blog-api`,
      endpointTypes: [EndpointType.REGIONAL],
      domainName: {
        domainName: props.domain,
        certificate: props.certificate,
      },
    });

    const lambdaIntegration = new LambdaIntegration(webApiLambda);
    const rootMethod = restApi.root.addMethod('ANY', lambdaIntegration);
    const proxyMethod = restApi.root.addResource('{proxy+}').addMethod('ANY', lambdaIntegration);

    [rootMethod, proxyMethod].forEach((method) => {
      const cfnMethod = method.node.defaultChild as CfnMethod;
      cfnMethod.addOverride('Properties.Integration.ResponseTransferMode', 'STREAM');
      cfnMethod.addOverride('Properties.Integration.TimeoutInMillis', 900000);
      cfnMethod.addOverride(
        'Properties.Integration.Uri',
        cdk.Fn.sub(
          'arn:aws:apigateway:${AWS::Region}:lambda:path/2021-11-15/functions/${LambdaArn}/response-streaming-invocations',
          { LambdaArn: webApiLambda.functionArn },
        ),
      );
    });

    new route53.ARecord(this, 'ApiAliasRecord', {
      zone: props.hostedZone,
      recordName: props.domain,
      target: route53.RecordTarget.fromAlias(new route53Targets.ApiGateway(restApi)),
    });

    new ssm.StringParameter(this, 'ApiUrlParam', {
      parameterName: props.ssmParameters.apiGateway.apiUrl,
      stringValue: `https://${props.domain}`,
    });
  }
}
