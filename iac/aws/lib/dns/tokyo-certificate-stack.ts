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
      hostedZoneId: string;
      certificateArnParameterName: string;
    } & cdk.StackProps
  ) {
    super(scope, id, props);

    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(
      this,
      'ImportedHostedZone',
      {
        hostedZoneId: props.hostedZoneId,
        zoneName: props.domainName,
      }
    );

    const certificate = new acm.Certificate(this, 'TokyoCertificate', {
      domainName: props.domainName,
      subjectAlternativeNames: [`*.${props.domainName}`],
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    new ssm.StringParameter(this, 'TokyoCertificateArnParameter', {
      parameterName: props.certificateArnParameterName,
      stringValue: certificate.certificateArn,
    });
  }
}
