import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

// tidb-proxy 用に最小 1 AZ で VPC を切る。
// - public subnet: Fargate proxy が ECR pull / Tailscale 接続のため Public IP 経由で外向き
// - private isolated subnet: Lambda (タスク 4 以降) を置く。NAT / VPC Endpoint は持たず、
//   外部通信はすべて proxy SG 経由 (squid + tsnet forwarder) でしか行えない
//
// 月コスト最適化のため NAT Gateway / VPC Endpoint はゼロ。Tailscale Pricing v4
// 対応の本質はここなので、ここを増やすと趣旨に反する。
export class ProxyVpcConstruct extends Construct {
  public readonly vpc: ec2.IVpc;
  public readonly publicSubnet: ec2.ISubnet;
  public readonly privateSubnet: ec2.ISubnet;

  constructor(
    scope: Construct,
    id: string,
    props: {
      cidr: string;
      ssm: {
        vpcId: string;
        publicSubnetId1: string;
        privateSubnetId1: string;
      };
    },
  ) {
    super(scope, id);

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr(props.cidr),
      // env-aware stack だと maxAzs だけだと AZ context lookup が走るので、ap-northeast-1a を明示する。
      // 1 AZ 構成 (SPOF 受容方針) のため。
      availabilityZones: ['ap-northeast-1a'],
      natGateways: 0,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
    });

    this.publicSubnet = this.vpc.publicSubnets[0]!;
    this.privateSubnet = this.vpc.isolatedSubnets[0]!;

    new ssm.StringParameter(this, 'VpcIdParam', {
      parameterName: props.ssm.vpcId,
      stringValue: this.vpc.vpcId,
    });
    new ssm.StringParameter(this, 'PublicSubnetId1Param', {
      parameterName: props.ssm.publicSubnetId1,
      stringValue: this.publicSubnet.subnetId,
    });
    new ssm.StringParameter(this, 'PrivateSubnetId1Param', {
      parameterName: props.ssm.privateSubnetId1,
      stringValue: this.privateSubnet.subnetId,
    });
  }
}
