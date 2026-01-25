import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

export class OidcProviderStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    props: {
      ssmOidcProviderArn: string;
    } & cdk.StackProps
  ) {
    super(scope, id, props);

    const provider = new iam.OpenIdConnectProvider(this, 'GithubActionsProvider', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
    });

    new ssm.StringParameter(this, 'OidcProviderArnParam', {
      parameterName: props.ssmOidcProviderArn,
      stringValue: provider.openIdConnectProviderArn,
    });
  }
}
