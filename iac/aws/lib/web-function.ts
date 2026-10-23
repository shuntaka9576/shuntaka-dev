import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';

// Lambda Web Functions には L2 が無いため L1 で組む。構成は PoC
// (~/repos/github.com/shuntaka9576/cf-lambda-web-functions) でデプロイして確かめたものに揃える。
// 設計は docs/source/98_tasks/2026-10-15-lambda-web-functions-survey/index.md を参照
export class WebFunction extends Construct {
  public readonly role: iam.Role;
  public readonly endpoint: lambda.CfnWebFunctionEndpoint;
  /** endpoint が向いている revision の ID。コードか設定が変わるたびに変わる */
  public readonly revisionId: string;
  private readonly functionArn: string;

  constructor(
    scope: Construct,
    id: string,
    props: {
      functionName: string;
      // Web Functions のコードはバージョニング有効な S3 バケットの zip からしか読めない
      codeBucket: s3.Bucket;
      // ルートに index.mjs を置いた zip。runtime は AWS_LAMBDA_NODEJS_ENTRYPOINT で読む
      code: s3deploy.ISource;
      timeoutSeconds: number;
      environment?: Record<string, string>;
      // バージョン付きの connector ARN。指定すると外向き通信が VPC 経由になる
      egressNetworkConnectorArn?: string;
      // endpoint が使える実行環境の上限 (最小値は 2)。メモリは 2 GB 固定で実行環境がある間
      // ずっと課金されるため、bot などでアクセスが急に増えても台数 (= 料金) が際限なく増えないようにする。
      // 上限に達すると、それ以上の並列リクエストは endpoint で絞られる
      maxEnvironments: number;
    },
  ) {
    super(scope, id);

    // CDK 同梱の CloudFormation 検証用 schema が Web Functions の発表前のもので、
    // リソース型と AWS::Lambda::NetworkConnector の LatestVersionArn を知らない
    // (どちらも CloudFormation Template Reference には載っている)
    cdk.Validations.of(this).acknowledge(
      {
        id: 'CloudFormation-Validate::F3006',
        reason: 'AWS::Lambda::WebFunction* は検証用 schema に未収録',
      },
      {
        id: 'CloudFormation-Validate::E9004',
        reason: 'NetworkConnector の LatestVersionArn は検証用 schema に未収録',
      },
    );

    const stack = cdk.Stack.of(this);

    // Lambda がコードを読めるよう、この関数の revision に限ってバケットの読み取りを許可する
    props.codeBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal('lambda.amazonaws.com')],
        actions: ['s3:GetObject', 's3:GetObjectVersion'],
        resources: [props.codeBucket.arnForObjects('*')],
        conditions: {
          ArnLike: {
            'aws:SourceArn': stack.formatArn({
              service: 'lambda',
              resource: 'web-function',
              resourceName: `${props.functionName}/revision/*`,
            }),
          },
        },
      }),
    );

    const code = new s3deploy.BucketDeployment(this, 'CodeDeployment', {
      sources: [props.code],
      destinationBucket: props.codeBucket,
      extract: false,
      // 稼働中の revision が参照するオブジェクトを消すと revision が Failed になるため prune しない
      prune: false,
    });

    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: `/aws/lambda-web/${props.functionName}`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.role = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    const webFunction = new lambda.CfnWebFunction(this, 'Function', {
      functionName: props.functionName,
    });
    this.functionArn = webFunction.attrFunctionArn;

    // revision は作成後に変更できない。コードや環境変数が変わると新しい revision に置き換わり、
    // endpoint の revisionWeights が新しい revision を指し直す
    const revision = new lambda.CfnWebFunctionRevision(this, 'Revision', {
      functionName: webFunction.attrFunctionArn,
      buildConfig: {
        codeConfig: {
          s3Object: {
            bucket: props.codeBucket.bucketName,
            key: cdk.Fn.select(0, code.objectKeys),
            versionId: cdk.Fn.select(0, code.objectVersionIds),
          },
        },
        runtimeConfig: { runtime: 'nodejs24.x' },
      },
      serviceConfig: {
        executionRoleArn: this.role.roleArn,
        timeoutSeconds: props.timeoutSeconds,
        egressNetworkConnectorArn: props.egressNetworkConnectorArn,
        environmentVariables: {
          // runtime は既定で index.js を読む。エントリは ESM なので .mjs を指定する
          AWS_LAMBDA_NODEJS_ENTRYPOINT: 'index.mjs',
          ...props.environment,
        },
        telemetryConfig: {
          loggingConfig: { logGroup: logGroup.logGroupName },
        },
      },
    });
    revision.node.addDependency(props.codeBucket.policy!);
    this.revisionId = revision.attrRevisionId;

    this.endpoint = new lambda.CfnWebFunctionEndpoint(this, 'Endpoint', {
      functionName: webFunction.attrFunctionArn,
      endpointName: 'prod',
      endpointType: 'HomeRegion',
      // CloudFront OAC から署名付きで呼ばせ、直接アクセスは 403 にする
      authType: 'IamAuth',
      revisionWeights: [{ revisionId: revision.attrRevisionId, weight: 100 }],
      scalingConfig: { maxEnvironments: props.maxEnvironments },
    });
  }

  /** CloudFront の origin。Host を転送すると endpoint が 404 を返すため、behavior 側で AllViewerExceptHostHeader を使う */
  public origin(originAccessControlId: string): origins.HttpOrigin {
    return new origins.HttpOrigin(this.endpoint.attrDomainName, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      originAccessControlId,
    });
  }

  /** Web Functions は AddPermission 非対応のため、リソースポリシーを丸ごと設定する */
  public allowInvokeFrom(distribution: cloudfront.IDistribution): void {
    new lambda.CfnResourcePolicy(this, 'ResourcePolicy', {
      resourceArn: this.functionArn,
      policyDocument: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
            actions: ['lambda:InvokeWebFunctionEndpoint'],
            resources: [this.endpoint.attrEndpointArn],
            conditions: {
              StringEquals: { 'aws:SourceArn': distribution.distributionArn },
            },
          }),
        ],
      }),
    });
  }
}
