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

// Web Function の zip 作成 (cargo zigbuild / next build) をスキップし、fixture に差し替える
const webBuildEnvs = vi.hoisted(() => [] as Record<string, string>[]);
vi.mock('../lib/web-function-package.js', async () => {
  const path = await import('node:path');
  const s3deploy = await import('aws-cdk-lib/aws-s3-deployment');
  const fixture = () =>
    s3deploy.Source.asset(path.join(import.meta.dirname, 'fixtures/web-function'));
  return {
    blogApiWebFunctionCode: fixture,
    webWebFunctionCode: (buildEnv: Record<string, string>) => {
      webBuildEnvs.push(buildEnv);
      return fixture();
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
        images: 'images.example.com',
      },
      labs: {
        repoFullName: 'shuntaka9576/lab-contents-dev',
        imagesBucketName: 'tp-dev-lab-assets',
      },
      web: {
        buildApiUrl: 'https://example.com/api',
        googleTagManagerId: 'GTM-TEST',
      },
      ssmParameters: {
        globalDns: {
          hostedZoneId: '/test/hosted-zone-id',
        },
        virginia: {
          webCertificateArn: '/test/virginia/web-certificate-arn',
        },
        dsql: {
          clusterEndpoint: '/test/dsql/cluster-endpoint',
          clusterArn: '/test/dsql/cluster-arn',
        },
        proxy: {
          vpcId: '/test/tidb-proxy/vpc/id',
          privateSubnetId1: '/test/tidb-proxy/vpc/private-subnet-id-1',
          privateSubnetId2: '/test/tidb-proxy/vpc/private-subnet-id-2',
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

    // NEXT_PUBLIC_* はビルド時に焼き込まれるため、next build に渡る値を確認する。未設定の ID は渡さない
    expect(webBuildEnvs).toEqual([
      {
        NEXT_PUBLIC_SITE_URL: 'https://example.com',
        API_URL: 'https://example.com/api',
        NEXT_PUBLIC_GOOGLE_TAG_MANAGER_ID: 'GTM-TEST',
      },
    ]);

    const template = Template.fromStack(stack);
    expect(template.toJSON()).toMatchSnapshot();
  });
});
