import * as cdk from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { DeployRoleStack } from '../lib/deployment/deploy-role-stack.js';
import { OidcProviderStack } from '../lib/deployment/oidc-provider-stack.js';
import { applyNag } from '../lib/nag.js';
import { applyDeployRoleSuppressions } from '../lib/nag-suppressions.js';

const expectNoNagErrors = (stack: cdk.Stack): void => {
  const errors = Annotations.fromStack(stack).findError(
    '*',
    Match.stringLikeRegexp('AwsSolutions-.*'),
  );
  expect(errors).toEqual([]);
};

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

    applyNag(stack);
    expectNoNagErrors(stack);

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

    applyNag(stack);
    applyDeployRoleSuppressions(stack);
    expectNoNagErrors(stack);

    const template = Template.fromStack(stack);
    expect(template.toJSON()).toMatchSnapshot();
  });
});
