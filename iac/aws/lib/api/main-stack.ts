import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as dsql from 'aws-cdk-lib/aws-dsql';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { BlogAPIConstruct } from './blog-api-construct.js';

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

    // WebApp: Lambda + API Gateway + Route53
    new BlogAPIConstruct(this, 'BlogAPI', {
      physicalPrefix,
      domain: props.domain.api,
      hostedZone,
      certificate: tokyoCertificate,
      dsqlClusterEndpoint,
      dsqlClusterArn,
      ssmParameters: {
        apiGateway: props.ssmParameters.apiGateway,
      },
      blogApiEnv: props.lambda.blogApi,
    });
  }
}
