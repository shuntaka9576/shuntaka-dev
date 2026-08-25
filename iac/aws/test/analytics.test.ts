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
      State: 'ENABLED',
    });
    template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
      StateMachineName: 'tidb-proxy-logs-vacuum',
      StateMachineType: 'STANDARD',
    });
    expect(JSON.stringify(template.findResources('AWS::StepFunctions::StateMachine'))).toContain(
      'VACUUM tidb_proxy_logs.logs',
    );
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 's3:PutObject',
            Effect: 'Allow',
            Resource: {
              'Fn::Join': [
                '',
                Match.arrayWith([
                  {
                    'Fn::GetAtt': ['LogAnalyticsLogsBucket18E6FEA3', 'Arn'],
                  },
                  '/iceberg/logs/metadata/*',
                ]),
              ],
            },
          }),
        ]),
      },
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['s3:PutObject']),
            Effect: 'Allow',
            Resource: {
              'Fn::Join': [
                '',
                [
                  'arn:',
                  { Ref: 'AWS::Partition' },
                  ':s3:::',
                  { Ref: 'LogAnalyticsLogsBucket18E6FEA3' },
                  '/athena-results/*',
                ],
              ],
            },
          }),
        ]),
      },
    });
    expect(template.toJSON()).toMatchSnapshot();
  });
});
