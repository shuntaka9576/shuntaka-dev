import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { GlobalDnsStack } from '../lib/dns/global-dns-stack.js';
import { TokyoCertificateStack } from '../lib/dns/tokyo-certificate-stack.js';

const expectNoNagErrors = (stack: cdk.Stack): void => {
  const report = new AwsSolutionsChecks(undefined, { verbose: true }).validateScope(stack);
  expect(report.violations).toEqual([]);
};

describe('GlobalDnsStack', () => {
  it('snapshot', () => {
    const app = new cdk.App();
    const stack = new GlobalDnsStack(app, 'TestGlobalDnsStack', {
      domainName: 'example.com',
      hostedZoneIdParameterName: '/test/hosted-zone-id',
      env: {
        account: '123456789012',
        region: 'ap-northeast-1',
      },
    });

    expectNoNagErrors(stack);

    const template = Template.fromStack(stack);
    expect(template.toJSON()).toMatchSnapshot();
  });
});

describe('TokyoCertificateStack', () => {
  it('snapshot', () => {
    const app = new cdk.App();
    const stack = new TokyoCertificateStack(app, 'TestTokyoCertificateStack', {
      domainName: 'example.com',
      hostedZoneIdParameterName: '/test/hosted-zone-id',
      certificateArnParameterName: '/test/certificate-arn',
      env: {
        account: '123456789012',
        region: 'ap-northeast-1',
      },
    });

    expectNoNagErrors(stack);

    const template = Template.fromStack(stack);
    expect(template.toJSON()).toMatchSnapshot();
  });
});
