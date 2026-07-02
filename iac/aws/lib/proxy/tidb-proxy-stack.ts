import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { type ProxyParameter } from '../config.js';
import { ProxyVpcConstruct } from './proxy-vpc-construct.js';
import { TidbProxyConstruct } from './tidb-proxy-construct.js';

// tidb-proxy stack は dev / prd 共用の shared stack。stageName による分岐は持たない。
// 中身は VPC + proxy インフラのスキャフォールドのみ。Task Definition / Service は
// ecspresso で管理する。
export class TidbProxyStack extends cdk.Stack {
  public readonly proxy: TidbProxyConstruct;

  constructor(
    scope: Construct,
    id: string,
    props: { proxyConfig: ProxyParameter } & cdk.StackProps,
  ) {
    super(scope, id, props);

    const vpcConstruct = new ProxyVpcConstruct(this, 'Vpc', {
      cidr: props.proxyConfig.vpc.cidr,
      ssm: props.proxyConfig.ssm.vpc,
    });

    this.proxy = new TidbProxyConstruct(this, 'Proxy', {
      projectName: props.proxyConfig.projectName,
      vpc: vpcConstruct.vpc,
      tailscale: props.proxyConfig.ssm.tailscale,
      ssm: { proxy: props.proxyConfig.ssm.proxy },
    });
  }
}
