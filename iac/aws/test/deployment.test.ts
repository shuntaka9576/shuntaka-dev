import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { DeployRoleStack } from '../lib/deployment/deploy-role-stack.js';
import { OidcProviderStack } from '../lib/deployment/oidc-provider-stack.js';
import { applyDeployRoleSuppressions } from '../lib/nag-suppressions.js';

const expectNoNagErrors = (stack: cdk.Stack): void => {
  const report = new AwsSolutionsChecks(undefined, { verbose: true }).validateScope(stack);
  expect(report.violations).toEqual([]);
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

    applyDeployRoleSuppressions(stack);
    expectNoNagErrors(stack);

    const template = Template.fromStack(stack);
    expect(template.toJSON()).toMatchSnapshot();
  });
});
