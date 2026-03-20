import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

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
    } & cdk.StackProps,
  ) {
    super(scope, id, props);

    const oidcProviderArn = ssm.StringParameter.valueForStringParameter(
      this,
      props.ssmOidcProviderArn,
    );
    const oidcProvider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      'OidcProvider',
      oidcProviderArn,
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
        'sts:AssumeRoleWithWebIdentity',
      ),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AWSCloudFormationFullAccess'),
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
