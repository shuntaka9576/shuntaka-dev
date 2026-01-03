import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import type { Construct } from 'constructs';
import { MainStack } from '../lib/api/main-stack';

// DockerImageFunctionをモックしてDockerビルドをスキップ
vi.mock('aws-cdk-lib/aws-lambda', async (importOriginal) => {
  const actual = await importOriginal<typeof lambda>();
  return {
    ...actual,
    DockerImageFunction: class MockDockerImageFunction extends actual.Function {
      constructor(
        scope: Construct,
        id: string,
        props: lambda.DockerImageFunctionProps
      ) {
        super(scope, id, {
          ...props,
          runtime: actual.Runtime.NODEJS_20_X,
          handler: 'index.handler',
          code: actual.Code.fromInline('exports.handler = () => {}'),
        });
      }
    },
    DockerImageCode: {
      fromImageAsset: () =>
        actual.Code.fromInline('exports.handler = () => {}'),
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

    const template = Template.fromStack(stack);
    expect(template.toJSON()).toMatchSnapshot();
  });
});
