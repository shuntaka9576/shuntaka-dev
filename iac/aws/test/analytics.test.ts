import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
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
    template.hasResourceProperties('AWS::KinesisFirehose::DeliveryStream', {
      IcebergDestinationConfiguration: Match.objectLike({
        BufferingHints: {
          IntervalInSeconds: 900,
          SizeInMBs: 64,
        },
      }),
    });
    template.hasResourceProperties('AWS::Events::Rule', {
      Name: 'tidb-proxy-logs-vacuum',
      ScheduleExpression: 'cron(0 18 * * ? *)',
      State: 'DISABLED',
    });
    template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
      StateMachineName: 'tidb-proxy-logs-vacuum',
      StateMachineType: 'STANDARD',
    });
    expect(JSON.stringify(template.findResources('AWS::StepFunctions::StateMachine'))).toContain(
      'VACUUM tidb_proxy_logs.logs',
    );
    expect(template.toJSON()).toMatchSnapshot();
  });
});
