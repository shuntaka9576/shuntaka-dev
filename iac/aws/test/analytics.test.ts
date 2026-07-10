import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { TidbProxyLogAnalyticsStack } from '../lib/analytics/tidb-proxy-log-analytics-stack.js';
import { getLogAnalyticsConfig } from '../lib/config.js';
import { applyTidbProxyLogAnalyticsSuppressions } from '../lib/nag-suppressions.js';

describe('TidbProxyLogAnalyticsStack', () => {
  it('snapshot', () => {
    const app = new cdk.App();
    const logAnalyticsConfig = getLogAnalyticsConfig();
    const stack = new TidbProxyLogAnalyticsStack(app, 'TestTidbProxyLogAnalyticsStack', {
      logAnalyticsConfig,
      env: {
        account: '123456789012',
        region: 'ap-northeast-1',
      },
    });

    applyTidbProxyLogAnalyticsSuppressions(stack);

    const report = new AwsSolutionsChecks(undefined, { verbose: true }).validateScope(stack);
    expect(report.violations).toEqual([]);

    const template = Template.fromStack(stack);
    expect(template.toJSON()).toMatchSnapshot();
  });
});
