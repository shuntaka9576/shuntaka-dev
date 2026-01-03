import * as cdk from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

export class GlobalDnsStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    props: {
      domainName: string;
      hostedZoneIdParameterName: string;
    } & cdk.StackProps
  ) {
    super(scope, id, props);

    const hostedZone = new route53.PublicHostedZone(this, 'Route53', {
      zoneName: props.domainName,
    });

    new ssm.StringParameter(this, 'HostedZoneIdParameter', {
      parameterName: props.hostedZoneIdParameterName,
      stringValue: hostedZone.hostedZoneId,
    });

    new cdk.CfnOutput(this, 'HostedZoneIdOutput', {
      value: hostedZone.hostedZoneId,
      exportName: `${this.stackName}-hosted-zone-id`,
    });
  }
}
