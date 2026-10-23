import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as dsql from 'aws-cdk-lib/aws-dsql';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { readCrossRegionParameter } from '../cross-region-ssm.js';
import { BlogAPIConstruct } from './blog-api-construct.js';
import { ObservabilityConstruct } from './observability-construct.js';
import { SiteConstruct } from './site-construct.js';

const VIRGINIA_REGION = 'us-east-1';

export class MainStack extends cdk.Stack {
  /** blog-api Event Function 実行ロールの ARN。AdminStack が lab 画像バケットへの権限付与に使う */
  public readonly blogApiLambdaRoleArn: string;

  constructor(
    scope: Construct,
    id: string,
    props: {
      projectName: { long: string; short: string };
      stageName: { long: string; short: string };
      fqdn: string;
      domain: {
        images: string;
      };
      labs: {
        repoFullName: string;
        imagesBucketName: string;
      };
      webFunction: {
        maxEnvironments: number;
      };
      observability: {
        healthcheckProbeIntervalMinutes?: number;
      };
      web: {
        buildApiUrl: string;
        googleTagManagerId?: string;
        clarityProjectId?: string;
      };
      ssmParameters: {
        globalDns: {
          hostedZoneId: string;
        };
        virginia: {
          webCertificateArn: string;
        };
        dsql: {
          clusterEndpoint: string;
          clusterArn: string;
        };
        proxy: {
          vpcId: string;
          privateSubnetId1: string;
          privateSubnetId2: string;
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

    // CloudFront 用の証明書は us-east-1 にあるため cross-region で読む (AdminStack と同じ流儀)
    const webCertificate = acm.Certificate.fromCertificateArn(
      this,
      'ImportedWebCertificate',
      readCrossRegionParameter(this, 'WebCertificateArnLookup', {
        parameterName: props.ssmParameters.virginia.webCertificateArn,
        region: VIRGINIA_REGION,
        refreshToken: props.fqdn,
      }),
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

    // Lambda Web Functions のコード置き場。Web Functions はバージョニング有効な S3 バケットの
    // zip からしかコードを読めない。blog-api と apps/web の 2 関数で共有する
    const webFunctionCodeBucket = new s3.Bucket(this, 'WebFunctionCodeBucket', {
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // blog-api: Web Function (HTTP) + Event Function (webhook の実処理)
    const blogApi = new BlogAPIConstruct(this, 'BlogAPI', {
      physicalPrefix,
      stageName: props.stageName.long,
      imagesBaseUrl: `https://${props.domain.images}`,
      labRepoFullName: props.labs.repoFullName,
      labImagesBucketName: props.labs.imagesBucketName,
      // stage 名そのまま (`dev` / `prd`) を TiDB の database 名サフィックスにする。
      databaseName: `blog_${props.stageName.long}`,
      webFunctionCodeBucket,
      webFunctionMaxEnvironments: props.webFunction.maxEnvironments,
      ssmParameters: {
        proxy: props.ssmParameters.proxy,
      },
      blogApiEnv: props.lambda.blogApi,
      observability: {
        otelServiceName,
      },
    });
    this.blogApiLambdaRoleArn = blogApi.webApiLambdaRoleArn;

    // 公開サイト: CloudFront + apps/web の Web Function + apex の DNS
    const siteUrl = `https://${props.fqdn}`;
    new SiteConstruct(this, 'Site', {
      physicalPrefix,
      fqdn: props.fqdn,
      hostedZone,
      certificate: webCertificate,
      webFunctionCodeBucket,
      webFunctionMaxEnvironments: props.webFunction.maxEnvironments,
      blogApi: blogApi.webFunction,
      buildEnv: {
        NEXT_PUBLIC_SITE_URL: siteUrl,
        API_URL: props.web.buildApiUrl,
        ...(props.web.googleTagManagerId && {
          NEXT_PUBLIC_GOOGLE_TAG_MANAGER_ID: props.web.googleTagManagerId,
        }),
        ...(props.web.clarityProjectId && {
          NEXT_PUBLIC_CLARITY_PROJECT_ID: props.web.clarityProjectId,
        }),
      },
    });

    // Observability: CloudWatch dashboard + SELECT 1 定期プローブ
    new ObservabilityConstruct(this, 'Observability', {
      physicalPrefix,
      apiBaseUrl: `${siteUrl}/api`,
      healthcheckProbeIntervalMinutes: props.observability.healthcheckProbeIntervalMinutes,
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
