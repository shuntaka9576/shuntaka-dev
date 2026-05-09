#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { MainStack } from '../lib/api/main-stack.js';
import { getConfig } from '../lib/config.js';
import { DeployRoleStack } from '../lib/deployment/deploy-role-stack.js';
import { OidcProviderStack } from '../lib/deployment/oidc-provider-stack.js';
import { GlobalDnsStack } from '../lib/dns/global-dns-stack.js';
import { TokyoCertificateStack } from '../lib/dns/tokyo-certificate-stack.js';
import { applyNag } from '../lib/nag.js';
import {
  applyDeployRoleSuppressions,
  applyMainStackSuppressions,
} from '../lib/nag-suppressions.js';

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

applyNag(app);
applyMainStackSuppressions(mainStack);
applyDeployRoleSuppressions(deployRoleStack);
