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
        'Action::ec2:*',
        'Action::ecs:*',
        'Action::servicediscovery:*',
        'Resource::*',
      ],
    },
  ]);
};

export const applyTidbProxySuppressions = (stack: cdk.Stack): void => {
  NagSuppressions.addStackSuppressions(stack, [
    {
      id: 'AwsSolutions-VPC7',
      reason:
        '個人ブログ用途で VPC Flow Logs (CloudWatch / S3) を恒常的に保持しない方針。proxy SG inbound は lambda-sg からの 2 ポートのみで、調査が必要な場合は手動で flow logs を有効化する。',
    },
    {
      id: 'AwsSolutions-ECS4',
      reason:
        'Container Insights の月コスト (~$1〜) を避けるため OFF。1 task 運用かつ awslogs driver で CloudWatch Logs に container ログを流すので、必要時にそこから調査する。',
    },
    {
      id: 'AwsSolutions-ECR1',
      reason:
        'private ECR repository で IAM role による認証ベースの pull のため、resource-based policy で別途プリンシパル制限する必要はない。',
    },
    {
      id: 'AwsSolutions-IAM4',
      reason:
        'ECS task ExecutionRole の AmazonECSTaskExecutionRolePolicy は ECR pull / CloudWatch Logs 書き込みの最小権限セットで、AWS 公式のベストプラクティス通り。カスタマー管理ポリシー化は無理に行わない。',
      appliesTo: [
        'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy',
      ],
    },
    {
      id: 'AwsSolutions-IAM5',
      reason:
        'ECS UpdateTaskProtection は対象 task が deploy 時に動的に決まるためリソース ARN を事前に絞れない。kms:Decrypt は SSM SecureString 復号用で default KMS key (alias/aws/ssm) のみに限定済み。',
      appliesTo: ['Resource::*'],
    },
  ]);
};

export const applyMainStackSuppressions = (stack: cdk.Stack): void => {
  NagSuppressions.addStackSuppressions(stack, [
    {
      id: 'AwsSolutions-IAM4',
      reason:
        'TODO(別PR): Lambda 実行ロールと API Gateway CloudWatchRole が CDK 既定で利用する AWS 管理ポリシーをカスタマー管理ポリシーに置き換える。AWSLambdaVPCAccessExecutionRole は VPC 内 Lambda の ENI 管理に必要な最小権限セットで AWS 公式のベストプラクティスのため許容。',
      appliesTo: [
        'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
        'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs',
        'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole',
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
