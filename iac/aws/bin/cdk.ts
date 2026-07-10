#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { TidbProxyLogAnalyticsStack } from '../lib/analytics/tidb-proxy-log-analytics-stack.js';
import { MainStack } from '../lib/api/main-stack.js';
import { getConfig, getLogAnalyticsConfig, getProxyConfig } from '../lib/config.js';
import { DeployRoleStack } from '../lib/deployment/deploy-role-stack.js';
import { OidcProviderStack } from '../lib/deployment/oidc-provider-stack.js';
import { GlobalDnsStack } from '../lib/dns/global-dns-stack.js';
import { TokyoCertificateStack } from '../lib/dns/tokyo-certificate-stack.js';
import { applyNag } from '../lib/nag.js';
import {
  applyDeployRoleSuppressions,
  applyMainStackSuppressions,
  applyTidbProxyLogAnalyticsSuppressions,
  applyTidbProxySuppressions,
} from '../lib/nag-suppressions.js';
import { TidbProxyStack } from '../lib/proxy/tidb-proxy-stack.js';

const REGIONS = {
  TOKYO: 'ap-northeast-1',
} as const;

const app = new cdk.App();

const stageNameKey = 'stageName';
const stageName = app.node.tryGetContext(stageNameKey);
const config = getConfig(stageName);

const globalDnsStack = new GlobalDnsStack(
  app,
  `${config.stageName.short}-${config.projectName.short}-global-dns`,
  {
    domainName: config.fqdn,
    hostedZoneIdParameterName: config.ssm.globalDns.hostedZoneId,
    env: {
      account: config.cdkEnv.account,
      region: REGIONS.TOKYO,
    },
  },
);

const tokyoCertificateStack = new TokyoCertificateStack(
  app,
  `${config.stageName.short}-${config.projectName.short}-tokyo-cert`,
  {
    domainName: config.fqdn,
    hostedZoneIdParameterName: config.ssm.globalDns.hostedZoneId,
    certificateArnParameterName: config.ssm.tokyo.certificateArn,
    env: {
      account: config.cdkEnv.account,
      region: REGIONS.TOKYO,
    },
  },
);

const mainStack = new MainStack(app, `${config.stageName.short}-${config.projectName.short}-main`, {
  projectName: config.projectName,
  stageName: config.stageName,
  fqdn: config.fqdn,
  domain: config.domain,
  ssmParameters: config.ssm,
  lambda: config.lambda,
  env: {
    account: config.cdkEnv.account,
    region: REGIONS.TOKYO,
  },
});

mainStack.addDependency(globalDnsStack);
mainStack.addDependency(tokyoCertificateStack);

// Lambda 用環境変数が未設定の場合、main stack のデプロイだけをブロックする。
// エラーは stack 単位に付くため、deploy-role 等の他スタックは .env なしの
// ローカル環境でも synth / deploy できる。
if (config.missingLambdaEnvVars.length > 0) {
  cdk.Annotations.of(mainStack).addError(
    `Lambda 用環境変数が未設定のため main stack はデプロイできません: ${config.missingLambdaEnvVars.join(', ')} (iac/aws/.env か環境変数で設定してください)`,
  );
}

const oidcProviderStack = new OidcProviderStack(app, `${config.projectName.short}-oidc-provider`, {
  ssmOidcProviderArn: config.ssm.oidc.providerArn,
  env: {
    account: config.cdkEnv.account,
    region: REGIONS.TOKYO,
  },
});

const deployRoleStack = new DeployRoleStack(
  app,
  `${config.stageName.short}-${config.projectName.short}-deploy-role`,
  {
    projectName: config.projectName.long,
    stageName: config.stageName.long,
    gitHubOwner: config.github.owner,
    gitHubRepo: config.github.repo,
    ssmOidcProviderArn: config.ssm.oidc.providerArn,
    env: {
      account: config.cdkEnv.account,
      region: REGIONS.TOKYO,
    },
  },
);

deployRoleStack.addDependency(oidcProviderStack);

// tidb-proxy stack は dev / prd 共用なので stageName prefix を付けない (OidcProviderStack と同じ流儀)。
const proxyConfig = getProxyConfig();
const tidbProxyStack = new TidbProxyStack(
  app,
  `${config.projectName.short}-${proxyConfig.projectName}`,
  {
    proxyConfig,
    env: {
      account: config.cdkEnv.account,
      region: REGIONS.TOKYO,
    },
  },
);

// tidb-proxy のログ分析基盤も dev / prd 共用なので stageName prefix を付けない。
// タスクロール等を st-tidb-proxy の SSM 出力から import するため依存を明示する。
const logAnalyticsConfig = getLogAnalyticsConfig();
const tidbProxyLogAnalyticsStack = new TidbProxyLogAnalyticsStack(
  app,
  `${config.projectName.short}-${logAnalyticsConfig.projectName}`,
  {
    logAnalyticsConfig,
    env: {
      account: config.cdkEnv.account,
      region: REGIONS.TOKYO,
    },
  },
);
tidbProxyLogAnalyticsStack.addDependency(tidbProxyStack);

applyNag(app);
applyMainStackSuppressions(mainStack);
applyDeployRoleSuppressions(deployRoleStack);
applyTidbProxySuppressions(tidbProxyStack);
applyTidbProxyLogAnalyticsSuppressions(tidbProxyLogAnalyticsStack);
