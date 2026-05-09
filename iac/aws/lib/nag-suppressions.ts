import type * as cdk from 'aws-cdk-lib';
import { NagSuppressions } from 'cdk-nag';

export const applyDeployRoleSuppressions = (stack: cdk.Stack): void => {
  NagSuppressions.addStackSuppressions(stack, [
    {
      id: 'AwsSolutions-IAM4',
      reason:
        'TODO(別PR): デプロイロールの AWS 管理ポリシー (CloudFormationFullAccess / IAMFullAccess / S3FullAccess) を Permissions Boundary + カスタマー管理ポリシーへ置き換える。',
      appliesTo: [
        'Policy::arn:<AWS::Partition>:iam::aws:policy/AWSCloudFormationFullAccess',
        'Policy::arn:<AWS::Partition>:iam::aws:policy/IAMFullAccess',
        'Policy::arn:<AWS::Partition>:iam::aws:policy/AmazonS3FullAccess',
      ],
    },
    {
      id: 'AwsSolutions-IAM5',
      reason:
        'TODO(別PR): デプロイロールのインライン IAM ステートメントの wildcard アクション / リソースをスコープ縮小する。',
      appliesTo: [
        'Action::lambda:*',
        'Action::apigateway:*',
        'Action::route53:*',
        'Action::acm:*',
        'Action::logs:*',
        'Resource::*',
      ],
    },
  ]);
};

export const applyMainStackSuppressions = (stack: cdk.Stack): void => {
  NagSuppressions.addStackSuppressions(stack, [
    {
      id: 'AwsSolutions-IAM4',
      reason:
        'TODO(別PR): Lambda 実行ロールと API Gateway CloudWatchRole が CDK 既定で利用する AWS 管理ポリシーをカスタマー管理ポリシーに置き換える。',
      appliesTo: [
        'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
        'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs',
      ],
    },
    {
      id: 'AwsSolutions-APIG1',
      reason:
        'TODO(別PR): API Gateway ステージのアクセスログを CloudWatch Logs に出力する設定を追加する。',
    },
    {
      id: 'AwsSolutions-APIG2',
      reason:
        'TODO(別PR): API Gateway のリクエスト検証 (RequestValidator + Model) を OpenAPI 整備とセットで追加する。',
    },
    {
      id: 'AwsSolutions-APIG4',
      reason:
        'API Gateway は {proxy+} ANY で全リクエストを Lambda にパススルーする構成のため Method 単位のオーソライザーは設定しない。書き込み系 (POST /webhooks/github) は Lambda 側で X-Hub-Signature-256 の HMAC 検証を実装済み。読み取り系 (GET /users/.../articles 等) は意図的に未認証の public エンドポイント。',
    },
    {
      id: 'AwsSolutions-APIG3',
      reason: 'TODO(別PR): API Gateway ステージに WAFv2 WebACL を associate する。',
    },
    {
      id: 'AwsSolutions-APIG6',
      reason:
        'TODO(別PR): API Gateway 全 Method の CloudWatch Logs 出力 (deployOptions.loggingLevel) を追加する。',
    },
    {
      id: 'AwsSolutions-COG4',
      reason:
        'Cognito User Pool による認証基盤を持たないプロジェクトのため不適合。認証が必要な書き込み系は GitHub Webhook (HMAC 検証) のみで、それ以外は public read。',
    },
  ]);
};
