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
      hostedZoneIdParameterName: string;
      hostedZoneParameterRegion: string;
      wildcardCertificateArnParameterName: string;
    } & cdk.StackProps,
  ) {
    super(scope, id, props);

    const hostedZoneId = readCrossRegionParameter(this, 'HostedZoneIdLookup', {
      parameterName: props.hostedZoneIdParameterName,
      region: props.hostedZoneParameterRegion,
      refreshToken: props.fqdn,
    });
    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'ImportedHostedZone', {
      hostedZoneId,
      zoneName: props.fqdn,
    });

    // apex とすべてのサブドメイン (admin / images / mcp ...) を 1 枚で受ける。CloudFront を使うのはすべてこれで、
    // サブドメインを増やしても証明書は作らない (ワイルドカードは apex を含まないため apex を本体の名前にする)。
    // 論理 ID を変えると証明書が作り直しになり、参照側の cross-region 読み出しも追従が要るため変えない
    const wildcardCertificate = new acm.Certificate(this, 'WildcardCertificate', {
      domainName: props.fqdn,
      subjectAlternativeNames: [`*.${props.fqdn}`],
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    new ssm.StringParameter(this, 'WildcardCertificateArnParameter', {
      parameterName: props.wildcardCertificateArnParameterName,
      stringValue: wildcardCertificate.certificateArn,
    });
  }
}
