import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import type * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import { AwsSolutionsChecks } from 'cdk-nag';
import type { Construct } from 'constructs';
import { AdminStack } from '../lib/admin/admin-stack.js';
import { VirginiaCertificateStack } from '../lib/dns/virginia-certificate-stack.js';
import {
  applyAdminStackSuppressions,
  applyVirginiaCertificateSuppressions,
} from '../lib/nag-suppressions.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// NodejsFunction をモックして esbuild バンドルをスキップ
// (api.test.ts の DockerImageFunction モックと同じ流儀)
vi.mock('aws-cdk-lib/aws-lambda-nodejs', async (importOriginal) => {
  const actual = await importOriginal<typeof nodejs>();
  const lambdaModule = await import('aws-cdk-lib/aws-lambda');
  return {
    ...actual,
    NodejsFunction: class MockNodejsFunction extends lambdaModule.Function {
      constructor(scope: Construct, id: string, props: nodejs.NodejsFunctionProps = {}) {
        super(scope, id, {
          functionName: props.functionName,
          memorySize: props.memorySize,
          timeout: props.timeout,
          architecture: props.architecture,
          loggingFormat: props.loggingFormat,
          logGroup: props.logGroup,
          vpc: props.vpc,
          vpcSubnets: props.vpcSubnets,
          securityGroups: props.securityGroups,
          environment: props.environment,
          runtime: lambdaModule.Runtime.NODEJS_24_X,
          handler: 'index.handler',
          code: lambdaModule.Code.fromInline('exports.handler = () => {}'),
        });
      }
    },
  };
});

const expectNoNagErrors = (stack: cdk.Stack): void => {
  const report = new AwsSolutionsChecks(undefined, { verbose: true }).validateScope(stack);
  expect(report.violations).toEqual([]);
};

describe('VirginiaCertificateStack', () => {
  it('snapshot', () => {
    const app = new cdk.App();
    const stack = new VirginiaCertificateStack(app, 'TestVirginiaCertificateStack', {
      fqdn: 'example.com',
      adminDomain: 'admin.example.com',
      imagesDomain: 'images.example.com',
      hostedZoneIdParameterName: '/test/hosted-zone-id',
      hostedZoneParameterRegion: 'ap-northeast-1',
      certificateArnParameterName: '/test/virginia/certificate-arn',
      env: {
        account: '123456789012',
        region: 'us-east-1',
      },
    });

    applyVirginiaCertificateSuppressions(stack);
    expectNoNagErrors(stack);

    const template = Template.fromStack(stack);
    expect(template.toJSON()).toMatchSnapshot();
  });
});

describe('AdminStack', () => {
  it('snapshot', () => {
    const app = new cdk.App();
    const stack = new AdminStack(app, 'TestAdminStack', {
      physicalPrefix: 'tp-dev',
      stageName: 'development',
      fqdn: 'example.com',
      adminDomain: 'admin.example.com',
      imagesDomain: 'images.example.com',
      databaseName: 'blog_dev',
      spaDistPath: path.resolve(__dirname, 'fixtures/admin-spa'),
      ssmParameters: {
        globalDns: { hostedZoneId: '/test/hosted-zone-id' },
        virginia: { certificateArn: '/test/virginia/certificate-arn' },
        admin: {
          userPoolId: '/test/admin/user-pool-id',
          userPoolClientId: '/test/admin/user-pool-client-id',
        },
        proxy: {
          vpcId: '/test/tidb-proxy/vpc/id',
          privateSubnetId1: '/test/tidb-proxy/vpc/private-subnet-id-1',
          sgId: '/test/tidb-proxy/proxy/sg-id',
        },
      },
      env: {
        account: '123456789012',
        region: 'ap-northeast-1',
      },
    });

    applyAdminStackSuppressions(stack);
    expectNoNagErrors(stack);

    const template = Template.fromStack(stack);
    expect(template.toJSON()).toMatchSnapshot();
  });
});
