import type * as cdk from 'aws-cdk-lib';
import { Validations } from 'aws-cdk-lib';

interface NagAcknowledgment {
  id: string;
  reason: string;
}

// Validations.of().acknowledge() は id 中の '::' を prefix 区切りとして解釈し、
// '::' を2回以上含む id (AwsSolutions-IAM4 の Policy ARN finding 等) を
// InvalidValidationId で拒否するため、cdk-nag が読むメタデータキーへ直接記録する。
const acknowledgeRules = (stack: cdk.Stack, rules: NagAcknowledgment[]): void => {
  for (const rule of rules) {
    stack.node.addMetadata(Validations.ACKNOWLEDGED_RULES_METADATA_KEY, {
      [rule.id]: rule.reason,
    });
  }
};

export const applyDeployRoleSuppressions = (stack: cdk.Stack): void => {
  const iam4Reason =
    'TODO(別PR): デプロイロールの AWS 管理ポリシー (CloudFormationFullAccess / IAMFullAccess / S3FullAccess) を Permissions Boundary + カスタマー管理ポリシーへ置き換える。';
  const iam5Reason =
    'TODO(別PR): デプロイロールのインライン IAM ステートメントの wildcard アクション / リソースをスコープ縮小する。';
  acknowledgeRules(stack, [
    ...[
      'Policy::arn:<AWS::Partition>:iam::aws:policy/AWSCloudFormationFullAccess',
      'Policy::arn:<AWS::Partition>:iam::aws:policy/IAMFullAccess',
      'Policy::arn:<AWS::Partition>:iam::aws:policy/AmazonS3FullAccess',
    ].map((finding) => ({ id: `AwsSolutions-IAM4[${finding}]`, reason: iam4Reason })),
    ...[
      'Action::lambda:*',
      'Action::apigateway:*',
      'Action::route53:*',
      'Action::acm:*',
      'Action::logs:*',
      'Action::ec2:*',
      'Action::ecs:*',
      'Action::servicediscovery:*',
      'Action::cloudwatch:*',
      'Action::events:*',
      'Action::glue:*',
      'Action::firehose:*',
      'Action::athena:*',
      'Resource::*',
    ].map((finding) => ({ id: `AwsSolutions-IAM5[${finding}]`, reason: iam5Reason })),
  ]);
};

export const applyTidbProxySuppressions = (stack: cdk.Stack): void => {
  acknowledgeRules(stack, [
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
      id: 'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy]',
      reason:
        'ECS task ExecutionRole の AmazonECSTaskExecutionRolePolicy は ECR pull / CloudWatch Logs 書き込みの最小権限セットで、AWS 公式のベストプラクティス通り。カスタマー管理ポリシー化は無理に行わない。',
    },
    {
      id: 'AwsSolutions-IAM5[Resource::*]',
      reason:
        'ECS UpdateTaskProtection は対象 task が deploy 時に動的に決まるためリソース ARN を事前に絞れない。kms:Decrypt は SSM SecureString 復号用で default KMS key (alias/aws/ssm) のみに限定済み。X-Ray (PutTraceSegments 等) と cloudwatch:PutMetricData はリソースレベル制限非対応の API。',
    },
  ]);
};

export const applyTidbProxyLogAnalyticsSuppressions = (stack: cdk.Stack): void => {
  const bucketWildcardReason =
    'Firehose 配信ロールは iceberg/ (テーブルデータ) と firehose-errors/ (失敗レコード) の両 prefix へ、BucketDeployment / autoDeleteObjects の custom resource はバケット全体へオブジェクトキー動的にアクセスするため、bucket/* のワイルドカードを許容する。バケット自体がログ基盤専用。';
  const customResourceLambdaReason =
    'BucketDeployment (FireLens 設定の S3 同期) と autoDeleteObjects が生成する CDK 管理の custom resource Lambda。実装は aws-cdk-lib 側の管理物のためポリシー / ランタイムはフレームワーク既定に従う。';
  acknowledgeRules(stack, [
    {
      id: 'AwsSolutions-S1',
      reason:
        '個人ブログ用途でサーバーアクセスログ用の追加バケット・コストを持たない方針 (tidb-proxy の VPC Flow Logs と同じ割り切り)。バケットへの書き込み主体は Firehose / BucketDeployment / Athena に限定されている。',
    },
    ...[
      'Action::s3:Abort*',
      'Action::s3:DeleteObject*',
      'Action::s3:GetBucket*',
      'Action::s3:GetObject*',
      'Action::s3:List*',
      'Resource::<LogAnalyticsLogsBucket18E6FEA3.Arn>/*',
    ].map((finding) => ({ id: `AwsSolutions-IAM5[${finding}]`, reason: bucketWildcardReason })),
    {
      id: 'AwsSolutions-IAM5[Resource::<LogAnalyticsLogsBucket18E6FEA3.Arn>/firelens-config/*]',
      reason:
        'tidb-proxy タスクロールが FireLens init プロセスで取得する Fluent Bit 設定ファイル群。firelens-config/ prefix 配下の GetObject のみに限定済み。',
    },
    {
      id: 'AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:s3:::cdk-hnb659fds-assets-123456789012-ap-northeast-1/*]',
      reason:
        'BucketDeployment の custom resource Lambda が CDK bootstrap の asset バケットから設定ファイルを取得するための CDK 既定権限。',
    },
    {
      // cspell:disable-next-line -- CFN パラメータ論理 ID (自動生成トークン)
      id: 'AwsSolutions-IAM5[Resource::arn:aws:logs:<AWS::Region>:<AWS::AccountId>:log-group:<SsmParameterValuetidbproxyproxyloggroupnameC96584B6F00A464EAD1953AFF4B05118Parameter>:*]',
      reason:
        'Fluent Bit の cloudwatch_logs 出力はタスク ID を含む log stream を動的に作るため、既存の /ecs/tidb-proxy ロググループ配下の stream ワイルドカードが必要。',
    },
    {
      id: 'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]',
      reason: customResourceLambdaReason,
    },
    {
      id: 'AwsSolutions-L1',
      reason: customResourceLambdaReason,
    },
  ]);
};

export const applyMainStackSuppressions = (stack: cdk.Stack): void => {
  const iam4Reason =
    'TODO(別PR): Lambda 実行ロールと API Gateway CloudWatchRole が CDK 既定で利用する AWS 管理ポリシーをカスタマー管理ポリシーに置き換える。AWSLambdaVPCAccessExecutionRole は VPC 内 Lambda の ENI 管理に必要な最小権限セットで AWS 公式のベストプラクティスのため許容。';
  acknowledgeRules(stack, [
    ...[
      'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
      'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs',
      'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole',
    ].map((finding) => ({ id: `AwsSolutions-IAM4[${finding}]`, reason: iam4Reason })),
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
