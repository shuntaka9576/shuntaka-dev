import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { readCrossRegionParameter } from '../cross-region-ssm.js';

// CloudFront 用の ACM 証明書は us-east-1 に置く必要があるため専用スタックにする。
// hosted zone ID は ap-northeast-1 の SSM に出力済みのため cross-region で読む
export class VirginiaCertificateStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    props: {
      fqdn: string;
      adminDomain: string;
      imagesDomain: string;
      hostedZoneIdParameterName: string;
      hostedZoneParameterRegion: string;
      certificateArnParameterName: string;
    } & cdk.StackProps,
  ) {
    super(scope, id, props);

    const hostedZoneId = readCrossRegionParameter(this, 'HostedZoneIdLookup', {
      parameterName: props.hostedZoneIdParameterName,
      region: props.hostedZoneParameterRegion,
    });
    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'ImportedHostedZone', {
      hostedZoneId,
      zoneName: props.fqdn,
    });

    const certificate = new acm.Certificate(this, 'VirginiaCertificate', {
      domainName: props.adminDomain,
      subjectAlternativeNames: [props.imagesDomain],
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    new ssm.StringParameter(this, 'VirginiaCertificateArnParameter', {
      parameterName: props.certificateArnParameterName,
      stringValue: certificate.certificateArn,
    });
  }
}
