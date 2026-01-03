import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import {
  type CfnMethod,
  EndpointType,
  LambdaIntegration,
  RestApi,
} from 'aws-cdk-lib/aws-apigateway';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as dsql from 'aws-cdk-lib/aws-dsql';
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
        path.resolve(__dirname, '../../../apps/blog-api')
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

export class GlobalDnsStack extends cdk.Stack {
  public readonly hostedZoneId: string;

  constructor(
    scope: Construct,
    id: string,
    props: {
      domainName: string;
      hostedZoneIdParameterName: string;
    } & cdk.StackProps
  ) {
    super(scope, id, props);

    const hostedZone = new cdk.aws_route53.PublicHostedZone(this, 'Route53', {
      zoneName: props.domainName,
    });

    this.hostedZoneId = hostedZone.hostedZoneId;

    new ssm.StringParameter(this, 'HostedZoneIdParameter', {
      parameterName: props.hostedZoneIdParameterName,
      stringValue: hostedZone.hostedZoneId,
    });

    new cdk.CfnOutput(this, 'HostedZoneIdOutput', {
      value: hostedZone.hostedZoneId,
      exportName: `${this.stackName}-hosted-zone-id`,
    });
  }
}

export class TokyoCertificateStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    props: {
      domainName: string;
      hostedZoneId: string;
      certificateArnParameterName: string;
    } & cdk.StackProps
  ) {
    super(scope, id, props);

    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(
      this,
      'ImportedHostedZone',
      {
        hostedZoneId: props.hostedZoneId,
        zoneName: props.domainName,
      }
    );

    const certificate = new acm.Certificate(this, 'TokyoCertificate', {
      domainName: props.domainName,
      subjectAlternativeNames: [`*.${props.domainName}`],
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    new ssm.StringParameter(this, 'TokyoCertificateArnParameter', {
      parameterName: props.certificateArnParameterName,
      stringValue: certificate.certificateArn,
    });
  }
}

export class OidcProviderStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    props: {
      ssmOidcProviderArn: string;
    } & cdk.StackProps
  ) {
    super(scope, id, props);

    const provider = new iam.OpenIdConnectProvider(
      this,
      'GithubActionsProvider',
      {
        url: 'https://token.actions.githubusercontent.com',
        clientIds: ['sts.amazonaws.com'],
      }
    );

    new ssm.StringParameter(this, 'OidcProviderArnParam', {
      parameterName: props.ssmOidcProviderArn,
      stringValue: provider.openIdConnectProviderArn,
    });
  }
}

export class DeployRoleStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    props: {
      projectName: string;
      stageName: string;
      gitHubOwner: string;
      gitHubRepo: string;
      ssmOidcProviderArn: string;
    } & cdk.StackProps
  ) {
    super(scope, id, props);

    const oidcProviderArn = ssm.StringParameter.valueForStringParameter(
      this,
      props.ssmOidcProviderArn
    );
    const oidcProvider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      'OidcProvider',
      oidcProviderArn
    );

    new iam.Role(this, 'AssumeRole', {
      roleName: `${props.stageName}-${props.projectName}-assume-role`,
      assumedBy: new iam.FederatedPrincipal(
        oidcProvider.openIdConnectProviderArn,
        {
          StringLike: {
            'token.actions.githubusercontent.com:sub': `repo:${props.gitHubOwner}/${props.gitHubRepo}:*`,
          },
        },
        'sts:AssumeRoleWithWebIdentity'
      ),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'AWSCloudFormationFullAccess'
        ),
        iam.ManagedPolicy.fromAwsManagedPolicyName('IAMFullAccess'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonS3FullAccess'),
      ],
      inlinePolicies: {
        lambdaApiGateway: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'ssm:GetParameter',
                'ssm:PutParameter',
                'lambda:*',
                'apigateway:*',
                'ecr:GetDownloadUrlForLayer',
                'ecr:BatchGetImage',
                'ecr:GetAuthorizationToken',
                'ecr:BatchCheckLayerAvailability',
                'ecr:PutImage',
                'ecr:InitiateLayerUpload',
                'ecr:UploadLayerPart',
                'ecr:CompleteLayerUpload',
                'ecr:DescribeRepositories',
                'ecr:DescribeImages',
                'ecr:CreateRepository',
                'ecr:DeleteRepository',
                'ecr:SetRepositoryPolicy',
                'logs:*',
                'route53:*',
                'acm:*',
              ],
              resources: ['*'],
            }),
          ],
        }),
      },
    });
  }
}

export class MainStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    props: {
      projectName: { long: string; short: string };
      stageName: { long: string; short: string };
      fqdn: string;
      domain: {
        api: string;
      };
      ssmParameters: {
        globalDns: {
          hostedZoneId: string;
        };
        tokyo: {
          certificateArn: string;
        };
        apiGateway: {
          apiUrl: string;
        };
        dsql: {
          clusterEndpoint: string;
          clusterArn: string;
        };
      };
      lambda: {
        blogApi: {
          githubAppId: string;
          githubAppSecretPemKeyName: string;
          githubWebhookSecretKeyName: string;
          cloudinaryCloudName: string;
          cloudinaryApiKey: string;
          cloudinaryApiSecretKeyName: string;
        };
      };
    } & cdk.StackProps
  ) {
    super(scope, id, props);

    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(
      this,
      'ImportedHostedZone',
      {
        hostedZoneId: ssm.StringParameter.valueForStringParameter(
          this,
          props.ssmParameters.globalDns.hostedZoneId
        ),
        zoneName: props.fqdn,
      }
    );

    const tokyoCertificate = acm.Certificate.fromCertificateArn(
      this,
      'ImportedTokyoCertificate',
      ssm.StringParameter.valueForStringParameter(
        this,
        props.ssmParameters.tokyo.certificateArn
      )
    );

    // Aurora DSQL Cluster（シングルリージョン・最小構成）
    const physicalPrefix = `${props.stageName.short}-${props.projectName.short}`;
    const dsqlCluster = new dsql.CfnCluster(this, 'DsqlCluster', {
      deletionProtectionEnabled: false,
      tags: [
        {
          key: 'Name',
          value: `${physicalPrefix}-dsql`,
        },
      ],
    });

    const dsqlClusterEndpoint = cdk.Fn.join('', [
      dsqlCluster.attrIdentifier,
      '.dsql.',
      this.region,
      '.on.aws',
    ]);
    const dsqlClusterArn = cdk.Fn.join('', [
      'arn:aws:dsql:',
      this.region,
      ':',
      this.account,
      ':cluster/',
      dsqlCluster.attrIdentifier,
    ]);

    // SSM Parameters for DSQL
    new ssm.StringParameter(this, 'DsqlClusterEndpointParam', {
      parameterName: props.ssmParameters.dsql.clusterEndpoint,
      stringValue: dsqlClusterEndpoint,
    });

    new ssm.StringParameter(this, 'DsqlClusterArnParam', {
      parameterName: props.ssmParameters.dsql.clusterArn,
      stringValue: dsqlClusterArn,
    });

    // WebApp: Lambda + API Gateway + Route53
    new BlogAPIConstruct(this, 'BlogAPI', {
      physicalPrefix,
      domain: props.domain.api,
      hostedZone,
      certificate: tokyoCertificate,
      dsqlClusterEndpoint,
      dsqlClusterArn,
      ssmParameters: {
        apiGateway: props.ssmParameters.apiGateway,
      },
      blogApiEnv: props.lambda.blogApi,
    });
  }
}
