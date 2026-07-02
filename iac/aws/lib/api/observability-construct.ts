import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { Construct } from 'constructs';

// ADOT Collector (iac/aws/ecspresso/tidb-proxy/otel-config.yaml) の awsemf
// exporter が出力する CloudWatch namespace / dimension と一致させること。
const METRIC_NAMESPACE = 'BlogRuntime';
const SERVICE_NAME_DIMENSION = 'service.name';

// Lambda -> forwarder -> TiDB のボトルネック切り分け用ダッシュボード。
//
// 読み方 (詳細はボトルネック分析計画を参照):
// - db.healthcheck.duration (SELECT 1) が遅い       -> 経路 (Tailscale/forwarder/接続) 側
// - SELECT 1 が速く db.query.duration だけ遅い       -> SQL/TiDB/TiKV 側 or 結果転送
// - db.query.duration 高 & TiDB statement duration 低 -> ネットワーク/proxy 側
//
// SELECT 1 ベースラインは EventBridge API Destination が /health/db を 5 分毎に
// 叩いて供給する。毎分にすると Lambda が常時 warm に保たれて cold start が
// 観測できなくなるため、cold start 込みの実態が見える間隔にしている。
export class ObservabilityConstruct extends Construct {
  constructor(
    scope: Construct,
    id: string,
    props: {
      physicalPrefix: string;
      apiDomain: string;
      lambdaServiceName: string;
      proxyServiceName: string;
    },
  ) {
    super(scope, id);

    // ---- db.healthcheck.duration の定期供給 (5 分毎の SELECT 1) ----
    // /health/db は公開エンドポイントのため認証は不要だが、EventBridge Connection
    // は auth 設定が必須なのでダミーヘッダーを渡す。
    const healthcheckConnection = new events.Connection(this, 'HealthcheckConnection', {
      authorization: events.Authorization.apiKey(
        'x-healthcheck-probe',
        cdk.SecretValue.unsafePlainText('scheduled-baseline-probe'),
      ),
      description: 'Dummy auth header for public /health/db probe',
    });

    const healthcheckDestination = new events.ApiDestination(this, 'HealthcheckDestination', {
      connection: healthcheckConnection,
      endpoint: `https://${props.apiDomain}/health/db`,
      httpMethod: events.HttpMethod.GET,
      rateLimitPerSecond: 1,
      description: 'Periodic SELECT 1 baseline probe (db.healthcheck.duration)',
    });

    new events.Rule(this, 'HealthcheckRule', {
      ruleName: `${props.physicalPrefix}-db-healthcheck-probe`,
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      targets: [
        new targets.ApiDestination(healthcheckDestination, {
          retryAttempts: 0,
          maxEventAge: cdk.Duration.minutes(1),
        }),
      ],
    });

    // ---- CloudWatch Dashboard ----
    const percentiles = (metricName: string, serviceName: string): cloudwatch.IMetric[] =>
      ['p50', 'p95', 'p99'].map(
        (stat) =>
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName,
            dimensionsMap: { [SERVICE_NAME_DIMENSION]: serviceName },
            statistic: stat,
            label: stat,
            period: cdk.Duration.minutes(1),
          }),
      );

    const sum = (metricName: string, serviceName: string): cloudwatch.IMetric =>
      new cloudwatch.Metric({
        namespace: METRIC_NAMESPACE,
        metricName,
        dimensionsMap: { [SERVICE_NAME_DIMENSION]: serviceName },
        statistic: 'Sum',
        label: metricName,
        period: cdk.Duration.minutes(1),
      });

    const latencyWidget = (title: string, metricName: string, serviceName: string) =>
      new cloudwatch.GraphWidget({
        title,
        left: percentiles(metricName, serviceName),
        leftYAxis: { label: 'ms', min: 0, showUnits: false },
        width: 8,
        height: 6,
      });

    const dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: `${props.physicalPrefix}-observability`,
    });

    dashboard.addWidgets(
      latencyWidget('Lambda request latency', 'app.request.duration', props.lambdaServiceName),
      latencyWidget('DB client latency', 'db.query.duration', props.lambdaServiceName),
      latencyWidget(
        'DB baseline latency (SELECT 1)',
        'db.healthcheck.duration',
        props.lambdaServiceName,
      ),
    );

    dashboard.addWidgets(
      latencyWidget('DB connection latency', 'db.connection.duration', props.lambdaServiceName),
      latencyWidget(
        'Forwarder upstream connect latency',
        'proxy.upstream.connect.duration',
        props.proxyServiceName,
      ),
      new cloudwatch.GraphWidget({
        title: 'Forwarder connections',
        left: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'proxy.connection.active',
            dimensionsMap: { [SERVICE_NAME_DIMENSION]: props.proxyServiceName },
            statistic: 'Maximum',
            label: 'proxy.connection.active',
            period: cdk.Duration.minutes(1),
          }),
          sum('proxy.connection.accept.count', props.proxyServiceName),
        ],
        width: 8,
        height: 6,
      }),
    );

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Forwarder errors',
        left: [
          sum('proxy.error.count', props.proxyServiceName),
          sum('proxy.timeout.count', props.proxyServiceName),
        ],
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Lambda cold starts / DB errors',
        left: [
          sum('lambda.cold_start.count', props.lambdaServiceName),
          sum('db.query.error.count', props.lambdaServiceName),
        ],
        width: 8,
        height: 6,
      }),
    );
  }
}
