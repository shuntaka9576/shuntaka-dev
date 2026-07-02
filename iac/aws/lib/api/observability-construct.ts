import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { Construct } from 'constructs';

// メトリクスは CloudWatch OTel Metrics (OTLP ネイティブ取り込み) に格納され、
// PromQL で参照する。ADOT Collector (iac/aws/ecspresso/tidb-proxy/otel-config.yaml)
// の otlphttp/cloudwatch exporter の送信先と対応する。
//
// PromQL 上の見え方:
// - ドット入りメトリクス名は {"db.query.duration_bucket", ...} の引用構文で参照
// - OTLP histogram は <name>_bucket 系列 + le ラベルになり histogram_quantile が使える
// - resource 属性は "@resource.service.name" 等のラベルとして付与される
//
// 注意: cumulative temporality のため、1 サンプルしか持たない系列 (一度だけ
// invoke されて消えた Lambda インスタンス等) は rate() に反映されない。
// リクエスト単位の悉皆データは X-Ray トレース側で確認する。

interface PromqlQuery {
  id: string;
  query: string;
  label?: string;
}

// CDK L2 (GraphWidget) は Classic メトリクス専用のため、dashboard body の
// `type: chart` ウィジェット (PromQL 対応) を直接出力する薄いラッパー。
class PromqlChartWidget extends cloudwatch.ConcreteWidget {
  private readonly title: string;
  private readonly queries: PromqlQuery[];

  constructor(props: { title: string; queries: PromqlQuery[]; width?: number; height?: number }) {
    super(props.width ?? 8, props.height ?? 6);
    this.title = props.title;
    this.queries = props.queries;
  }

  toJson(): Record<string, unknown>[] {
    return [
      {
        type: 'chart',
        x: this.x,
        y: this.y,
        width: this.width,
        height: this.height,
        properties: {
          view: 'line',
          title: this.title,
          region: cdk.Aws.REGION,
          data: {
            queries: this.queries.map((q) => ({
              id: q.id,
              type: 'cloudwatch-metrics',
              language: 'PromQL',
              query: q.query,
              ...(q.label ? { label: q.label } : {}),
            })),
          },
        },
      },
    ];
  }
}

const serviceMatcher = (serviceName: string): string => `"@resource.service.name"="${serviceName}"`;

// histogram の p50/p95/p99。rate window は SELECT 1 プローブ間隔 (5 分) でも
// 2 サンプル以上入るよう 15m にしている。
const latencyQuantiles = (metricName: string, serviceName: string): PromqlQuery[] =>
  [
    { quantile: '0.5', label: 'p50' },
    { quantile: '0.95', label: 'p95' },
    { quantile: '0.99', label: 'p99' },
  ].map(({ quantile, label }) => ({
    id: label,
    label,
    query: `histogram_quantile(${quantile}, sum by (le) (rate({"${metricName}_bucket", ${serviceMatcher(serviceName)}}[15m])))`,
  }));

const counterIncrease = (id: string, metricName: string, serviceName: string): PromqlQuery => ({
  id,
  label: `${metricName} (15m)`,
  query: `sum(increase({"${metricName}", ${serviceMatcher(serviceName)}}[15m]))`,
});

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

    // ---- CloudWatch Dashboard (PromQL / OTel Metrics) ----
    const dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: `${props.physicalPrefix}-observability`,
    });

    dashboard.addWidgets(
      new PromqlChartWidget({
        title: 'Lambda request latency',
        queries: latencyQuantiles('app.request.duration', props.lambdaServiceName),
      }),
      new PromqlChartWidget({
        title: 'DB client latency',
        queries: latencyQuantiles('db.query.duration', props.lambdaServiceName),
      }),
      new PromqlChartWidget({
        title: 'DB baseline latency (SELECT 1)',
        queries: latencyQuantiles('db.healthcheck.duration', props.lambdaServiceName),
      }),
    );

    dashboard.addWidgets(
      new PromqlChartWidget({
        title: 'DB connection latency',
        queries: latencyQuantiles('db.connection.duration', props.lambdaServiceName),
      }),
      new PromqlChartWidget({
        title: 'Forwarder upstream connect latency',
        queries: latencyQuantiles('proxy.upstream.connect.duration', props.proxyServiceName),
      }),
      new PromqlChartWidget({
        title: 'Forwarder connections',
        queries: [
          {
            id: 'active',
            label: 'proxy.connection.active',
            query: `sum({"proxy.connection.active", ${serviceMatcher(props.proxyServiceName)}})`,
          },
          counterIncrease('accepts', 'proxy.connection.accept.count', props.proxyServiceName),
        ],
      }),
    );

    dashboard.addWidgets(
      new PromqlChartWidget({
        title: 'Forwarder errors',
        queries: [
          counterIncrease('errors', 'proxy.error.count', props.proxyServiceName),
          counterIncrease('timeouts', 'proxy.timeout.count', props.proxyServiceName),
        ],
      }),
      new PromqlChartWidget({
        title: 'Lambda cold starts / DB errors',
        queries: [
          counterIncrease('coldstarts', 'lambda.cold_start.count', props.lambdaServiceName),
          counterIncrease('dberrors', 'db.query.error.count', props.lambdaServiceName),
        ],
      }),
    );
  }
}
