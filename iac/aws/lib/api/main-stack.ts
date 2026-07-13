import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as dsql from 'aws-cdk-lib/aws-dsql';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { BlogAPIConstruct } from './blog-api-construct.js';
import { ObservabilityConstruct } from './observability-construct.js';

export class MainStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    props: {
      projectName: { long: string; short: string };
      stageName: { long: string; short: string };
      fqdn: string;
      domain: {
        api: string;
        images: string;
      };
      ssmParameters: {
        globalDns: {
          hostedZoneId: string;
        };
        tokyo: {
          certificateArn: string;
        };
        apiGateway: {
          apiUrl: string;
        };
        dsql: {
          clusterEndpoint: string;
          clusterArn: string;
        };
        proxy: {
          vpcId: string;
          privateSubnetId1: string;
          sgId: string;
        };
      };
      lambda: {
        blogApi: {
          githubAppId: string;
          githubAppSecretPemKeyName: string;
          githubWebhookSecretKeyName: string;
          cloudinaryCloudName: string;
          cloudinaryApiKey: string;
          cloudinaryApiSecretKeyName: string;
        };
      };
    } & cdk.StackProps,
  ) {
    super(scope, id, props);

    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'ImportedHostedZone', {
      hostedZoneId: ssm.StringParameter.valueForStringParameter(
        this,
        props.ssmParameters.globalDns.hostedZoneId,
      ),
      zoneName: props.fqdn,
    });

    const tokyoCertificate = acm.Certificate.fromCertificateArn(
      this,
      'ImportedTokyoCertificate',
      ssm.StringParameter.valueForStringParameter(this, props.ssmParameters.tokyo.certificateArn),
    );

    // Aurora DSQL Cluster（シングルリージョン・最小構成）
    const physicalPrefix = `${props.stageName.short}-${props.projectName.short}`;
    const dsqlCluster = new dsql.CfnCluster(this, 'DsqlCluster', {
      deletionProtectionEnabled: false,
      tags: [
        {
          key: 'Name',
          value: `${physicalPrefix}-dsql`,
        },
      ],
    });

    const dsqlClusterEndpoint = cdk.Fn.join('', [
      dsqlCluster.attrIdentifier,
      '.dsql.',
      this.region,
      '.on.aws',
    ]);
    const dsqlClusterArn = cdk.Fn.join('', [
      'arn:aws:dsql:',
      this.region,
      ':',
      this.account,
      ':cluster/',
      dsqlCluster.attrIdentifier,
    ]);

    // SSM Parameters for DSQL
    new ssm.StringParameter(this, 'DsqlClusterEndpointParam', {
      parameterName: props.ssmParameters.dsql.clusterEndpoint,
      stringValue: dsqlClusterEndpoint,
    });

    new ssm.StringParameter(this, 'DsqlClusterArnParam', {
      parameterName: props.ssmParameters.dsql.clusterArn,
      stringValue: dsqlClusterArn,
    });

    // OTel resource の service.name。Lambda env と CloudWatch dashboard の
    // dimension の両方で使うためここで一元的に決める。
    const otelServiceName = `blog-api-${props.stageName.long}`;

    // WebApp: Lambda + API Gateway + Route53
    new BlogAPIConstruct(this, 'BlogAPI', {
      physicalPrefix,
      stageName: props.stageName.long,
      domain: props.domain.api,
      imagesBaseUrl: `https://${props.domain.images}`,
      hostedZone,
      certificate: tokyoCertificate,
      // stage 名そのまま (`dev` / `prd`) を TiDB の database 名サフィックスにする。
      databaseName: `blog_${props.stageName.long}`,
      ssmParameters: {
        apiGateway: props.ssmParameters.apiGateway,
        proxy: props.ssmParameters.proxy,
      },
      blogApiEnv: props.lambda.blogApi,
      observability: {
        otelServiceName,
      },
    });

    // Observability: CloudWatch dashboard + SELECT 1 定期プローブ
    new ObservabilityConstruct(this, 'Observability', {
      physicalPrefix,
      apiDomain: props.domain.api,
      lambdaServiceName: otelServiceName,
      // tidb-proxy は dev / prd 共用のため service.name も stage 非依存
      proxyServiceName: 'tidb-proxy',
    });
    // 旧 DSQL クラスタ / endpoint は dsqlCluster 定義として上に残しているが、blog-api は
    // Tailnet 経由で TiDB に接続するため Lambda 側から DSQL ARN は参照しない。
    // DSQL クラスタそのものの撤去はタスク4 (iac/aws の DSQL 撤去) で実施。
    void dsqlClusterEndpoint;
    void dsqlClusterArn;
  }
}
