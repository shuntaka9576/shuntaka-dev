import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

export class TokyoCertificateStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    props: {
      domainName: string;
      hostedZoneIdParameterName: string;
      certificateArnParameterName: string;
    } & cdk.StackProps,
  ) {
    super(scope, id, props);

    const hostedZoneId = ssm.StringParameter.valueForStringParameter(
      this,
      props.hostedZoneIdParameterName,
    );

    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'ImportedHostedZone', {
      hostedZoneId: hostedZoneId,
      zoneName: props.domainName,
    });

    const certificate = new acm.Certificate(this, 'TokyoCertificate', {
      domainName: props.domainName,
      subjectAlternativeNames: [`*.${props.domainName}`],
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });
    // API Gateway が旧証明書を参照したままでもドメイン移行を進められるよう、
    // 置換時だけ旧証明書を保持する。切り替え確認後に手動で整理する。
    const cfnCertificate = certificate.node.defaultChild as acm.CfnCertificate;
    cfnCertificate.cfnOptions.updateReplacePolicy = cdk.CfnDeletionPolicy.RETAIN;

    new ssm.StringParameter(this, 'TokyoCertificateArnParameter', {
      parameterName: props.certificateArnParameterName,
      stringValue: certificate.certificateArn,
    });
  }
}
