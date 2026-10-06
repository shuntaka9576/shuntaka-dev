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
    template.hasResourceProperties('AWS::KinesisFirehose::DeliveryStream', {
      IcebergDestinationConfiguration: Match.objectLike({
        CatalogConfiguration: {
          CatalogArn: {
            'Fn::Join': ['', Match.arrayWith([':catalog/s3tablescatalog/tidb-proxy-logs-tables'])],
          },
        },
        DestinationTableConfigurationList: [
          {
            DestinationDatabaseName: 'tidb_proxy_logs',
            DestinationTableName: 'logs',
          },
        ],
      }),
    });
    template.hasResourceProperties('AWS::S3Tables::TableBucket', {
      TableBucketName: 'tidb-proxy-logs-tables',
      UnreferencedFileRemoval: { Status: 'Enabled' },
    });
    template.hasResourceProperties('AWS::S3Tables::Table', {
      Namespace: 'tidb_proxy_logs',
      TableName: 'logs',
      OpenTableFormat: 'ICEBERG',
      Compaction: { Status: 'enabled' },
      SnapshotManagement: {
        Status: 'enabled',
        MaxSnapshotAgeHours: 336,
        MinSnapshotsToKeep: 1,
      },
    });
    template.hasResourceProperties('AWS::Glue::Catalog', {
      Name: 's3tablescatalog',
      FederatedCatalog: Match.objectLike({ ConnectionName: 'aws:s3tables' }),
      AllowFullTableExternalDataAccess: 'True',
    });
    // VACUUM の自前運用は S3 Tables のマネージドメンテナンスに置き換えた
    template.resourceCountIs('AWS::StepFunctions::StateMachine', 0);
    template.resourceCountIs('AWS::Events::Rule', 0);
    expect(template.toJSON()).toMatchSnapshot();
  });
});
