import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { DeployRoleStack } from '../lib/deployment/deploy-role-stack';
import { OidcProviderStack } from '../lib/deployment/oidc-provider-stack';

describe('OidcProviderStack', () => {
  it('snapshot', () => {
    const app = new cdk.App();
    const stack = new OidcProviderStack(app, 'TestOidcProviderStack', {
      ssmOidcProviderArn: '/test/oidc-provider-arn',
      env: {
        account: '123456789012',
        region: 'ap-northeast-1',
      },
    });

    const template = Template.fromStack(stack);
    expect(template.toJSON()).toMatchSnapshot();
  });
});

describe('DeployRoleStack', () => {
  it('snapshot', () => {
    const app = new cdk.App();
    const stack = new DeployRoleStack(app, 'TestDeployRoleStack', {
      projectName: 'test-project',
      stageName: 'dev',
      gitHubOwner: 'test-owner',
      gitHubRepo: 'test-repo',
      ssmOidcProviderArn: '/test/oidc-provider-arn',
      env: {
        account: '123456789012',
        region: 'ap-northeast-1',
      },
    });

    const template = Template.fromStack(stack);
    expect(template.toJSON()).toMatchSnapshot();
  });
});
