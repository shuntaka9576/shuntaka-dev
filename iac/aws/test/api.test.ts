import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import { AwsSolutionsChecks } from 'cdk-nag';
import type { Construct } from 'constructs';
import { MainStack } from '../lib/api/main-stack.js';
import { applyMainStackSuppressions } from '../lib/nag-suppressions.js';

// DockerImageFunctionをモックしてDockerビルドをスキップ
vi.mock('aws-cdk-lib/aws-lambda', async (importOriginal) => {
  const actual = await importOriginal<typeof lambda>();
  return {
    ...actual,
    DockerImageFunction: class MockDockerImageFunction extends actual.Function {
      constructor(scope: Construct, id: string, props: lambda.DockerImageFunctionProps) {
        super(scope, id, {
          ...props,
          runtime: actual.Runtime.NODEJS_20_X,
          handler: 'index.handler',
          code: actual.Code.fromInline('exports.handler = () => {}'),
        });
      }
    },
    DockerImageCode: {
      fromImageAsset: () => actual.Code.fromInline('exports.handler = () => {}'),
    },
  };
});

describe('MainStack', () => {
  it('snapshot', () => {
    const app = new cdk.App();
    const stack = new MainStack(app, 'TestMainStack', {
      projectName: { long: 'test-project', short: 'tp' },
      stageName: { long: 'development', short: 'dev' },
      fqdn: 'example.com',
      domain: {
        api: 'api.example.com',
        images: 'images.example.com',
      },
      labs: {
        repoFullName: 'shuntaka9576/lab-contents-dev',
        imagesBucketName: 'tp-dev-lab-assets',
      },
      ssmParameters: {
        globalDns: {
          hostedZoneId: '/test/hosted-zone-id',
        },
        tokyo: {
          certificateArn: '/test/certificate-arn',
        },
        apiGateway: {
          apiUrl: '/test/api-url',
        },
        dsql: {
          clusterEndpoint: '/test/dsql/cluster-endpoint',
          clusterArn: '/test/dsql/cluster-arn',
        },
        proxy: {
          vpcId: '/test/tidb-proxy/vpc/id',
          privateSubnetId1: '/test/tidb-proxy/vpc/private-subnet-id-1',
          sgId: '/test/tidb-proxy/proxy/sg-id',
        },
      },
      lambda: {
        blogApi: {
          githubAppId: '12345',
          githubAppSecretPemKeyName: '/test/gh-app-secret',
          githubWebhookSecretKeyName: '/test/gh-webhook-secret',
          cloudinaryCloudName: 'test-cloud',
          cloudinaryApiKey: 'test-api-key',
          cloudinaryApiSecretKeyName: '/test/cloudinary-secret',
        },
      },
      env: {
        account: '123456789012',
        region: 'ap-northeast-1',
      },
    });

    applyMainStackSuppressions(stack);
    // テスト用に DockerImageFunction を NODEJS_20_X の Function に差し替えているため
    // L1 (latest runtime) ルールが発火する。本番は Docker イメージなので該当しない。
    cdk.Validations.of(stack.node.findChild('BlogAPI').node.findChild('WebApiLambda')).acknowledge({
      id: 'AwsSolutions-L1',
      reason:
        'テスト用に DockerImageFunction をモックして Node.js ランタイム関数に差し替えている。本番は Docker イメージのため非該当。',
    });

    const report = new AwsSolutionsChecks(undefined, { verbose: true }).validateScope(stack);
    expect(report.violations).toEqual([]);

    const template = Template.fromStack(stack);
    expect(template.toJSON()).toMatchSnapshot();
  });
});
