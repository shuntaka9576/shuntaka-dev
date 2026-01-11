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
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class BlogAPIConstruct extends Construct {
  constructor(
    scope: Construct,
    id: string,
    props: {
      physicalPrefix: string;
      domain: string;
      hostedZone: route53.IHostedZone;
      certificate: acm.ICertificate;
      dsqlClusterEndpoint: string;
      dsqlClusterArn: string;
      ssmParameters: {
        apiGateway: {
          apiUrl: string;
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
    }
  ) {
    super(scope, id);

    // Docker Lambda
    const webApiLambda = new lambda.DockerImageFunction(this, 'WebApiLambda', {
      functionName: `${props.physicalPrefix}-blog-api`,
      code: lambda.DockerImageCode.fromImageAsset(
        path.resolve(__dirname, '../../../..')
      ),
      memorySize: 1024,
      timeout: cdk.Duration.seconds(15 * 60),
      architecture: lambda.Architecture.ARM_64,
      loggingFormat: lambda.LoggingFormat.JSON,
      logGroup: new logs.LogGroup(this, 'BlogApiLogGroup', {
        logGroupName: `/aws/lambda/${props.physicalPrefix}-blog-api`,
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      environment: {
        AWS_LWA_INVOKE_MODE: 'response_stream',
        DSQL_CLUSTER_ENDPOINT: props.dsqlClusterEndpoint,
        GH_APP_ID: props.blogApiEnv.githubAppId,
        GH_APP_SECRET_PEM_KEY_NAME: props.blogApiEnv.githubAppSecretPemKeyName,
        GH_WEBHOOK_SECRET_KEY_NAME: props.blogApiEnv.githubWebhookSecretKeyName,
        CLOUDINARY_CLOUD_NAME: props.blogApiEnv.cloudinaryCloudName,
        CLOUDINARY_API_KEY: props.blogApiEnv.cloudinaryApiKey,
        CLOUDINARY_API_SECRET_KEY_NAME:
          props.blogApiEnv.cloudinaryApiSecretKeyName,
      },
    });

    // DSQL接続用IAMポリシー
    webApiLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['dsql:DbConnectAdmin'],
        resources: [props.dsqlClusterArn],
      })
    );

    // SSM Parameter Store読み取り用IAMポリシー
    webApiLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ssm:GetParameter'],
        resources: [
          `arn:aws:ssm:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:parameter${props.blogApiEnv.githubAppSecretPemKeyName}`,
          `arn:aws:ssm:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:parameter${props.blogApiEnv.githubWebhookSecretKeyName}`,
          `arn:aws:ssm:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:parameter${props.blogApiEnv.cloudinaryApiSecretKeyName}`,
        ],
      })
    );

    // REST API with custom domain
    const restApi = new RestApi(this, 'RestApi', {
      restApiName: `${props.physicalPrefix}-blog-api`,
      endpointTypes: [EndpointType.REGIONAL],
      domainName: {
        domainName: props.domain,
        certificate: props.certificate,
      },
    });

    // Lambda Integration
    const lambdaIntegration = new LambdaIntegration(webApiLambda);
    const rootMethod = restApi.root.addMethod('ANY', lambdaIntegration);
    const proxyMethod = restApi.root
      .addResource('{proxy+}')
      .addMethod('ANY', lambdaIntegration);

    // ストリーミング対応の設定（CloudFormationオーバーライド）
    [rootMethod, proxyMethod].forEach((method) => {
      const cfnMethod = method.node.defaultChild as CfnMethod;
      cfnMethod.addOverride(
        'Properties.Integration.ResponseTransferMode',
        'STREAM'
      );
      cfnMethod.addOverride('Properties.Integration.TimeoutInMillis', 900000);
      cfnMethod.addOverride(
        'Properties.Integration.Uri',
        cdk.Fn.sub(
          'arn:aws:apigateway:${AWS::Region}:lambda:path/2021-11-15/functions/${LambdaArn}/response-streaming-invocations',
          { LambdaArn: webApiLambda.functionArn }
        )
      );
    });

    // Route53 A Record
    new route53.ARecord(this, 'ApiAliasRecord', {
      zone: props.hostedZone,
      recordName: props.domain,
      target: route53.RecordTarget.fromAlias(
        new route53Targets.ApiGateway(restApi)
      ),
    });

    // SSM Parameters
    new ssm.StringParameter(this, 'ApiUrlParam', {
      parameterName: props.ssmParameters.apiGateway.apiUrl,
      stringValue: `https://${props.domain}`,
    });
  }
}
