import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { readCrossRegionParameter } from '../cross-region-ssm.js';
import { WebFunction } from '../web-function.js';
import { mcpServerWebFunctionCode } from '../web-function-package.js';
import { MCP_OAUTH } from './mcp-oauth.js';

const VIRGINIA_REGION = 'us-east-1';

// ブログの MCP サーバー (mcp.<fqdn>)。apps/mcp-server を Web Function で動かし、CloudFront を前に置く。
// - /mcp      認証なし。誰でも記事を検索・取得できる
// - /auth/mcp Cognito (admin のユーザープール) でログインする。DCR に対応し、Muse などの
//             Custom Connector として登録できる
// ツールは blog-api の公開 API (https://<fqdn>/api) を呼ぶだけで、DB や VPC には触れない
export class McpStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    props: {
      physicalPrefix: string;
      fqdn: string;
      mcpDomain: string;
      /** 記事を取得するブログのユーザー名 (apps/web の USER_NAME と同じ) */
      blogUserName: string;
      /** Web Function の endpoint が使える実行環境の上限 */
      webFunctionMaxEnvironments: number;
      ssmParameters: {
        globalDns: { hostedZoneId: string };
        virginia: { wildcardCertificateArn: string };
        admin: { userPoolId: string; mcpClientId: string; cognitoDomainUrl: string };
      };
    } & cdk.StackProps,
  ) {
    super(scope, id, props);

    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'ImportedHostedZone', {
      hostedZoneId: ssm.StringParameter.valueForStringParameter(
        this,
        props.ssmParameters.globalDns.hostedZoneId,
      ),
      zoneName: props.fqdn,
    });
    // apex とサブドメインで共有するワイルドカード証明書 (<fqdn> + *.<fqdn>)
    const certificate = acm.Certificate.fromCertificateArn(
      this,
      'ImportedCertificate',
      readCrossRegionParameter(this, 'CertificateArnLookup', {
        parameterName: props.ssmParameters.virginia.wildcardCertificateArn,
        region: VIRGINIA_REGION,
        refreshToken: props.mcpDomain,
      }),
    );
    // AdminStack が作る Cognito のアプリクライアントとログイン用ドメイン
    const userPoolId = ssm.StringParameter.valueForStringParameter(
      this,
      props.ssmParameters.admin.userPoolId,
    );
    const cognitoClientId = ssm.StringParameter.valueForStringParameter(
      this,
      props.ssmParameters.admin.mcpClientId,
    );
    const cognitoDomainUrl = ssm.StringParameter.valueForStringParameter(
      this,
      props.ssmParameters.admin.cognitoDomainUrl,
    );

    // OAuth の状態 (DCR で登録したクライアント、認可トランザクション、認可コード、トークンの対応)。
    // 実行環境が複数あっても同じ状態を見られるように置く。値はアプリが暗号化してから書く
    const tokenTable = new dynamodb.Table(this, 'OAuthStateTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // 消えても MCP クライアントが再認証すれば戻る
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // JWT の署名鍵・保存値の暗号鍵・同意画面の署名鍵の元。アプリが用途ごとに鍵を導出する
    const keySecret = new secretsmanager.Secret(this, 'OAuthKeySecret', {
      description: 'MCP サーバーの OAuth 用の鍵 (JWT 署名・保存値の暗号化・同意画面の署名)',
      generateSecretString: { passwordLength: 64, excludePunctuation: true },
    });

    // Lambda Web Functions のコード置き場 (バージョニング有効な S3 バケットの zip からしか読めない)
    const webFunctionCodeBucket = new s3.Bucket(this, 'WebFunctionCodeBucket', {
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const siteUrl = `https://${props.fqdn}`;
    const server = new WebFunction(this, 'WebFunction', {
      functionName: `${props.physicalPrefix}-mcp-server`,
      codeBucket: webFunctionCodeBucket,
      code: mcpServerWebFunctionCode(),
      timeoutSeconds: 30,
      maxEnvironments: props.webFunctionMaxEnvironments,
      // Bearer トークンを OAC の署名で上書きさせないため、認証はアプリに任せる
      authType: 'ApplicationManaged',
      environment: {
        APP_AWS_REGION: this.region,
        MCP_BASE_URL: `https://${props.mcpDomain}`,
        SITE_URL: siteUrl,
        BLOG_API_URL: `${siteUrl}/api`,
        BLOG_USER_NAME: props.blogUserName,
        TOKEN_TABLE_NAME: tokenTable.tableName,
        KEY_SECRET_ARN: keySecret.secretArn,
        COGNITO_USER_POOL_ID: userPoolId,
        COGNITO_CLIENT_ID: cognitoClientId,
        COGNITO_DOMAIN_URL: cognitoDomainUrl,
        ACCESS_TOKEN_TTL_SECONDS: String(MCP_OAUTH.accessTokenValidity.toSeconds()),
        SESSION_TTL_SECONDS: String(MCP_OAUTH.sessionValidity.toSeconds()),
      },
    });
    tokenTable.grantReadWriteData(server.role);
    keySecret.grantRead(server.role);
    // Cognito のクライアントシークレットは環境変数に載せず、起動時に読む
    server.role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['cognito-idp:DescribeUserPoolClient'],
        resources: [
          this.formatArn({
            service: 'cognito-idp',
            resource: 'userpool',
            resourceName: userPoolId,
          }),
        ],
      }),
    );

    // Authorization をキャッシュキーに入れ、どのメソッドでもオリジンへ転送させる。アプリはすべての応答に
    // Cache-Control: no-store を付けるため、実際にはキャッシュされない
    const cachePolicy = new cloudfront.CachePolicy(this, 'CachePolicy', {
      cachePolicyName: `${props.physicalPrefix}-mcp-server`,
      minTtl: cdk.Duration.seconds(0),
      defaultTtl: cdk.Duration.seconds(0),
      maxTtl: cdk.Duration.seconds(1),
      headerBehavior: cloudfront.CacheHeaderBehavior.allowList('Authorization'),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
    });

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `${props.physicalPrefix}-mcp-server`,
      domainNames: [props.mcpDomain],
      certificate,
      // 日本のエッジを含める (PRICE_CLASS_100 は北米 / 欧州のみ)
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      defaultBehavior: {
        origin: server.origin(),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        // MCP の POST、DCR・トークン・同意画面の POST、CORS の OPTIONS を通す
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy,
        // Host を転送すると Web Function が自分宛てと判定できず 404 を返す
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      },
    });

    new route53.ARecord(this, 'AliasRecord', {
      zone: hostedZone,
      recordName: props.mcpDomain,
      target: route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(distribution)),
    });
    new route53.AaaaRecord(this, 'AliasRecordIpv6', {
      zone: hostedZone,
      recordName: props.mcpDomain,
      target: route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(distribution)),
    });

    new cdk.CfnOutput(this, 'PublicMcpUrl', { value: `https://${props.mcpDomain}/mcp` });
    new cdk.CfnOutput(this, 'AuthMcpUrl', { value: `https://${props.mcpDomain}/auth/mcp` });
    new cdk.CfnOutput(this, 'OAuthStateTableName', { value: tokenTable.tableName });
  }
}
