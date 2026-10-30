import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { McpStack } from '../lib/mcp/mcp-stack.js';
import { applyMcpStackSuppressions } from '../lib/nag-suppressions.js';

// Web Function の zip 作成 (esbuild) をスキップし、fixture に差し替える
vi.mock('../lib/web-function-package.js', async () => {
  const path = await import('node:path');
  const s3deploy = await import('aws-cdk-lib/aws-s3-deployment');
  return {
    mcpServerWebFunctionCode: () =>
      s3deploy.Source.asset(path.join(import.meta.dirname, 'fixtures/web-function')),
  };
});

describe('McpStack', () => {
  it('snapshot', () => {
    const app = new cdk.App();
    const stack = new McpStack(app, 'TestMcpStack', {
      physicalPrefix: 'tp-dev',
      fqdn: 'example.com',
      mcpDomain: 'mcp.example.com',
      blogUserName: 'shuntaka',
      webFunctionMaxEnvironments: 2,
      ssmParameters: {
        globalDns: { hostedZoneId: '/test/hosted-zone-id' },
        virginia: { wildcardCertificateArn: '/test/virginia/wildcard-certificate-arn' },
        admin: {
          userPoolId: '/test/admin/user-pool-id',
          mcpClientId: '/test/admin/mcp-client-id',
          cognitoDomainUrl: '/test/admin/cognito-domain-url',
        },
      },
      env: {
        account: '123456789012',
        region: 'ap-northeast-1',
      },
    });

    applyMcpStackSuppressions(stack);
    const report = new AwsSolutionsChecks(undefined, { verbose: true }).validateScope(stack);
    expect(report.violations).toEqual([]);

    const template = Template.fromStack(stack);
    // Bearer トークンを OAC の署名で上書きさせないため、OAC を付けずにアプリが認証する
    template.hasResourceProperties('AWS::Lambda::WebFunctionEndpoint', {
      AuthType: 'ApplicationManaged',
    });
    template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 0);
    template.hasResourceProperties('AWS::CloudFront::CachePolicy', {
      CachePolicyConfig: {
        ParametersInCacheKeyAndForwardedToOrigin: {
          HeadersConfig: { HeaderBehavior: 'whitelist', Headers: ['Authorization'] },
        },
      },
    });
    expect(template.toJSON()).toMatchSnapshot();
  });
});
