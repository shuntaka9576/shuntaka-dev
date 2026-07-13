import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { readCrossRegionParameter } from '../cross-region-ssm.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VIRGINIA_REGION = 'us-east-1';

// moments 管理画面 (admin.<fqdn>) 一式。設計は
// docs/source/98_tasks/2026-07-12-logs-admin-architecture/index.md を参照
export class AdminStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    props: {
      physicalPrefix: string;
      stageName: string;
      fqdn: string;
      adminDomain: string;
      imagesDomain: string;
      databaseName: string;
      // テストでは fixture に差し替える
      spaDistPath?: string;
      ssmParameters: {
        globalDns: { hostedZoneId: string };
        virginia: { certificateArn: string };
        admin: { userPoolId: string; userPoolClientId: string };
        proxy: { vpcId: string; privateSubnetId1: string; sgId: string };
      };
    } & cdk.StackProps,
  ) {
    super(scope, id, props);

    const isPrd = props.stageName === 'prd';

    // ---- Cognito (SRP ログイン用。管理者 1 ユーザーは admin-create-user で手動作成) ----
    const userPool = new cognito.UserPool(this, 'AdminUserPool', {
      userPoolName: `${props.physicalPrefix}-admin`,
      selfSignUpEnabled: false,
      signInAliases: { username: true },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      mfa: cognito.Mfa.OFF,
      // 単一管理ユーザー運用のためセルフサービスのアカウント回復は持たない
      accountRecovery: cognito.AccountRecovery.NONE,
      removalPolicy: isPrd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      // dev は作り直し前提のため保護しない
      deletionProtection: isPrd,
    });
    const userPoolClient = userPool.addClient('AdminSpaClient', {
      userPoolClientName: `${props.physicalPrefix}-admin-spa`,
      generateSecret: false,
      authFlows: { userSrp: true },
      refreshTokenValidity: cdk.Duration.days(30),
      enableTokenRevocation: true,
      preventUserExistenceErrors: true,
    });

    // ---- Cookie 暗号鍵 (Secrets Manager で自動生成) ----
    const cookieSecret = new secretsmanager.Secret(this, 'CookieSecret', {
      secretName: `${props.physicalPrefix}-admin-cookie-secret`,
      description: 'admin セッション Cookie の暗号鍵 (iron-webcrypto seal 用)',
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
    });
    // VPC 内 Lambda (NAT なし) から Secrets Manager へ届かないため、blog-api の
    // SecureString と同じく deploy 時に AwsCustomResource で値を取り出して env 注入する
    const cookieSecretLookup = new cdk.custom_resources.AwsCustomResource(
      this,
      'CookieSecretLookup',
      {
        onUpdate: {
          service: 'SecretsManager',
          action: 'GetSecretValue',
          parameters: { SecretId: cookieSecret.secretArn },
          physicalResourceId: cdk.custom_resources.PhysicalResourceId.of(cookieSecret.secretArn),
        },
        policy: cdk.custom_resources.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ['secretsmanager:GetSecretValue'],
            resources: [cookieSecret.secretArn],
          }),
        ]),
      },
    );
    cookieSecretLookup.node.addDependency(cookieSecret);
    const cookieSecretValue = cookieSecretLookup.getResponseField('SecretString');

    // ---- images バケット (公開配信は CloudFront /images/*、アップロードは presigned PUT) ----
    const imagesBucket = new s3.Bucket(this, 'ImagesBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      // ユーザーコンテンツのため prd は残す
      removalPolicy: isPrd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !isPrd,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT],
          allowedOrigins: [
            `https://${props.adminDomain}`,
            // dev はローカル開発 (Vite dev server) からの直 PUT も許可する
            ...(isPrd ? [] : ['http://localhost:*']),
          ],
          allowedHeaders: ['content-type'],
          maxAge: 3000,
        },
      ],
    });

    // ---- SPA バケット ----
    const spaBucket = new s3.Bucket(this, 'SpaBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // ---- admin-api Lambda (Hono。VPC 配置は blog-api と同じ SSM import パターン) ----
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

    const adminApiSg = new ec2.SecurityGroup(this, 'AdminApiSg', {
      vpc: proxyVpc,
      securityGroupName: `admin-api-sg-${props.stageName}`,
      description: `admin-api lambda SG for ${props.stageName}`,
      allowAllOutbound: false,
    });
    adminApiSg.addEgressRule(proxySecurityGroup, ec2.Port.tcp(13306), 'mysql via tidb-proxy');
    adminApiSg.addEgressRule(proxySecurityGroup, ec2.Port.tcp(3128), 'https via tidb-proxy');
    proxySecurityGroup.addIngressRule(
      adminApiSg,
      ec2.Port.tcp(13306),
      `mysql from admin-api-sg-${props.stageName}`,
    );
    proxySecurityGroup.addIngressRule(
      adminApiSg,
      ec2.Port.tcp(3128),
      `https from admin-api-sg-${props.stageName}`,
    );

    const proxyDnsName = 'tidb-proxy.internal';
    const proxyHttpUrl = `http://${proxyDnsName}:3128`;

    const adminApiLambda = new nodejs.NodejsFunction(this, 'AdminApiLambda', {
      functionName: `${props.physicalPrefix}-admin-api`,
      entry: path.resolve(__dirname, '../../../../apps/admin-api/src/index.ts'),
      depsLockFilePath: path.resolve(__dirname, '../../../../bun.lock'),
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      // API Gateway HTTP API のタイムアウト上限 (30 秒) に合わせる
      timeout: cdk.Duration.seconds(29),
      loggingFormat: lambda.LoggingFormat.JSON,
      logGroup: new logs.LogGroup(this, 'AdminApiLogGroup', {
        logGroupName: `/aws/lambda/${props.physicalPrefix}-admin-api`,
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      vpc: proxyVpc,
      vpcSubnets: { subnets: [proxyPrivateSubnet] },
      securityGroups: [adminApiSg],
      bundling: {
        format: nodejs.OutputFormat.ESM,
        target: 'node24',
        minify: true,
        // ESM バンドル内の CJS 依存 (mysql2 等) の require を解決する shim
        banner:
          "import { createRequire } from 'node:module';const require = createRequire(import.meta.url);",
        // cardinal は mysql2 の optional dependency (try/catch 内 require)
        externalModules: ['@aws-sdk/*', 'cardinal'],
      },
      environment: {
        DATABASE_URL: `mysql://root@${proxyDnsName}:13306/${props.databaseName}`,
        COGNITO_USER_POOL_ID: userPool.userPoolId,
        COGNITO_CLIENT_ID: userPoolClient.userPoolClientId,
        // VPC 内から Secrets Manager へ届かないため値を直接注入する (COOKIE_SECRET_ID は使わない)
        COOKIE_SECRET: cookieSecretValue,
        IMAGES_BUCKET_NAME: imagesBucket.bucketName,
        IMAGES_BASE_URL: `https://${props.imagesDomain}`,
        ORIGIN_ALLOWLIST: `https://${props.adminDomain}`,
        // 外部 HTTPS (Cognito API / JWKS) は squid forward proxy 経由。
        // NODE_USE_ENV_PROXY は Node 22.15+ の global fetch を proxy 対応にする
        HTTPS_PROXY: proxyHttpUrl,
        HTTP_PROXY: proxyHttpUrl,
        NO_PROXY: `169.254.169.254,localhost,127.0.0.1,${proxyDnsName}`,
        NODE_USE_ENV_PROXY: '1',
      },
    });
    adminApiLambda.role?.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
    );
    // presigned PUT URL の署名者として images バケットへの PutObject を許可
    imagesBucket.grantPut(adminApiLambda, 'images/moments/*');

    // ---- API Gateway HTTP API ----
    const httpApi = new apigwv2.HttpApi(this, 'AdminHttpApi', {
      apiName: `${props.physicalPrefix}-admin-api`,
    });
    httpApi.addRoutes({
      path: '/{proxy+}',
      methods: [apigwv2.HttpMethod.ANY],
      integration: new HttpLambdaIntegration('AdminApiIntegration', adminApiLambda),
    });

    // ---- CloudFront (admin + images の 2 エイリアス) ----
    const certificateArn = readCrossRegionParameter(this, 'VirginiaCertArnLookup', {
      parameterName: props.ssmParameters.virginia.certificateArn,
      region: VIRGINIA_REGION,
    });
    const certificate = acm.Certificate.fromCertificateArn(
      this,
      'ImportedVirginiaCertificate',
      certificateArn,
    );

    // Host チェック (admin 以外 403) + SPA fallback。default と /api/* の両 behavior に
    // アタッチし、images ホストで管理画面・API を露出させない
    const hostGuardFunction = new cloudfront.Function(this, 'HostGuardFunction', {
      functionName: `${props.physicalPrefix}-admin-host-guard`,
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var host = request.headers.host && request.headers.host.value;
  if (host !== '${props.adminDomain}') {
    return { statusCode: 403, statusDescription: 'Forbidden' };
  }
  var uri = request.uri;
  if (uri.startsWith('/api/')) {
    return request;
  }
  if (uri.includes('.')) {
    return request;
  }
  request.uri = '/index.html';
  return request;
}
`),
    });

    const distribution = new cloudfront.Distribution(this, 'AdminDistribution', {
      comment: `${props.physicalPrefix}-admin`,
      domainNames: [props.adminDomain, props.imagesDomain],
      certificate,
      // 日本のエッジを含める (PRICE_CLASS_100 は北米 / 欧州のみ)
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(spaBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        functionAssociations: [
          {
            function: hostGuardFunction,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
      additionalBehaviors: {
        '/api/*': {
          origin: new origins.HttpOrigin(
            `${httpApi.apiId}.execute-api.${this.region}.${cdk.Aws.URL_SUFFIX}`,
          ),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          functionAssociations: [
            {
              function: hostGuardFunction,
              eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
            },
          ],
        },
        '/images/*': {
          origin: origins.S3BucketOrigin.withOriginAccessControl(imagesBucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        },
      },
    });

    // ---- SPA 資材の投入 (apps/admin-web の build 成果物が前提) ----
    const spaDistPath =
      props.spaDistPath ?? path.resolve(__dirname, '../../../../apps/admin-web/dist');
    if (existsSync(spaDistPath)) {
      new s3deploy.BucketDeployment(this, 'SpaDeployment', {
        sources: [s3deploy.Source.asset(spaDistPath)],
        destinationBucket: spaBucket,
        distribution,
        distributionPaths: ['/*'],
      });
    } else {
      // main stack の missingLambdaEnvVars と同じ流儀で、この stack のデプロイだけをブロックする
      cdk.Annotations.of(this).addError(
        `admin-web のビルド成果物が見つかりません: ${spaDistPath} (apps/admin-web で bun run build を実行してください)`,
      );
    }

    // ---- Route53 (admin / images とも同一 CloudFront へ) ----
    const hostedZoneId = ssm.StringParameter.valueForStringParameter(
      this,
      props.ssmParameters.globalDns.hostedZoneId,
    );
    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'ImportedHostedZone', {
      hostedZoneId,
      zoneName: props.fqdn,
    });
    new route53.ARecord(this, 'AdminAliasRecord', {
      zone: hostedZone,
      recordName: props.adminDomain,
      target: route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(distribution)),
    });
    new route53.ARecord(this, 'ImagesAliasRecord', {
      zone: hostedZone,
      recordName: props.imagesDomain,
      target: route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(distribution)),
    });

    // ---- SSM 出力 (CI の admin-web ビルドと admin-create-user 手順が参照) ----
    new ssm.StringParameter(this, 'UserPoolIdParam', {
      parameterName: props.ssmParameters.admin.userPoolId,
      stringValue: userPool.userPoolId,
    });
    new ssm.StringParameter(this, 'UserPoolClientIdParam', {
      parameterName: props.ssmParameters.admin.userPoolClientId,
      stringValue: userPoolClient.userPoolClientId,
    });
  }
}
