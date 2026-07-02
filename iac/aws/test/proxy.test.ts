import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { getProxyConfig } from '../lib/config.js';
import { applyTidbProxySuppressions } from '../lib/nag-suppressions.js';
import { TidbProxyStack } from '../lib/proxy/tidb-proxy-stack.js';

describe('TidbProxyStack', () => {
  it('snapshot', () => {
    const app = new cdk.App();
    const proxyConfig = getProxyConfig();
    const stack = new TidbProxyStack(app, 'TestTidbProxyStack', {
      proxyConfig,
      env: {
        account: '123456789012',
        region: 'ap-northeast-1',
      },
    });

    applyTidbProxySuppressions(stack);

    const report = new AwsSolutionsChecks(undefined, { verbose: true }).validateScope(stack);
    expect(report.violations).toEqual([]);

    const template = Template.fromStack(stack);
    expect(template.toJSON()).toMatchSnapshot();
  });
});
