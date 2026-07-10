import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { type LogAnalyticsParameter } from '../config.js';
import { TidbProxyLogAnalyticsConstruct } from './tidb-proxy-log-analytics-construct.js';

// tidb-proxy のログ分析基盤 (S3 + Glue Iceberg + Firehose + Athena)。
// tidb-proxy 本体が dev / prd 共用 1 task のため、本スタックも共用の shared stack。
// stageName による分岐は持たない。
export class TidbProxyLogAnalyticsStack extends cdk.Stack {
  public readonly logAnalytics: TidbProxyLogAnalyticsConstruct;

  constructor(
    scope: Construct,
    id: string,
    props: { logAnalyticsConfig: LogAnalyticsParameter } & cdk.StackProps,
  ) {
    super(scope, id, props);

    this.logAnalytics = new TidbProxyLogAnalyticsConstruct(this, 'LogAnalytics', {
      config: props.logAnalyticsConfig,
    });
  }
}
