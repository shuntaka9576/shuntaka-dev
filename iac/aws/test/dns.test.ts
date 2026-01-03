import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { GlobalDnsStack } from '../lib/dns/global-dns-stack';
import { TokyoCertificateStack } from '../lib/dns/tokyo-certificate-stack';

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

    const template = Template.fromStack(stack);
    expect(template.toJSON()).toMatchSnapshot();
  });
});

describe('TokyoCertificateStack', () => {
  it('snapshot', () => {
    const app = new cdk.App();
    const stack = new TokyoCertificateStack(app, 'TestTokyoCertificateStack', {
      domainName: 'example.com',
      hostedZoneId: 'Z1234567890ABC',
      certificateArnParameterName: '/test/certificate-arn',
      env: {
        account: '123456789012',
        region: 'ap-northeast-1',
      },
    });

    const template = Template.fromStack(stack);
    expect(template.toJSON()).toMatchSnapshot();
  });
});
