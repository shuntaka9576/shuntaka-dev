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
      webCertificateArnParameterName: string;
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

    const certificate = new acm.Certificate(this, 'VirginiaCertificate', {
      domainName: props.adminDomain,
      subjectAlternativeNames: [props.imagesDomain],
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });
    // CloudFront が旧証明書を参照したままでもドメイン移行を進められるよう、
    // 置換時だけ旧証明書を保持する。切り替え確認後に手動で整理する。
    const cfnCertificate = certificate.node.defaultChild as acm.CfnCertificate;
    cfnCertificate.cfnOptions.updateReplacePolicy = cdk.CfnDeletionPolicy.RETAIN;

    new ssm.StringParameter(this, 'VirginiaCertificateArnParameter', {
      parameterName: props.certificateArnParameterName,
      stringValue: certificate.certificateArn,
    });

    // 公開サイト (apex) の CloudFront 用。admin / images 用の証明書に SAN を足すと置換になり、
    // AdminStack の cross-region 読み出しが旧 ARN を掴んだままになるため別の証明書にする
    const webCertificate = new acm.Certificate(this, 'WebCertificate', {
      domainName: props.fqdn,
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    new ssm.StringParameter(this, 'WebCertificateArnParameter', {
      parameterName: props.webCertificateArnParameterName,
      stringValue: webCertificate.certificateArn,
    });

    // apex とすべてのサブドメイン (admin / images / mcp ...) を 1 枚で受ける。サブドメインを増やすたびに
    // 証明書を作らなくて済むようにする (ワイルドカードは apex を含まないため apex を本体の名前にする)。
    // MainStack / AdminStack / McpStack はこれを使う。上の 2 枚は CloudFront が参照しなくなった後に消す
    // (CloudFront が使っている間は削除できず、このスタックは参照側より先にデプロイされるため同じデプロイでは消せない)
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
