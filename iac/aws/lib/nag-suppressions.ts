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
      'Action::cognito-idp:*',
      'Action::cloudfront:*',
      'Action::secretsmanager:*',
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
    // BucketDeployment の custom resource Lambda が CDK bootstrap の asset バケット
    // から設定ファイルを取得するための CDK 既定権限。finding の ARN はアカウント ID
    // を含み、partition もテスト synth ではトークン (<AWS::Partition>)、実アカウント
    // の synth ではリテラル (aws) になるため、stack の env から動的に両方 acknowledge する。
    ...['<AWS::Partition>', 'aws'].map((partition) => ({
      id: `AwsSolutions-IAM5[Resource::arn:${partition}:s3:::cdk-hnb659fds-assets-${stack.account}-${stack.region}/*]`,
      reason:
        'BucketDeployment の custom resource Lambda が CDK bootstrap の asset バケットから設定ファイルを取得するための CDK 既定権限。',
    })),
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

export const applyVirginiaCertificateSuppressions = (stack: cdk.Stack): void => {
  const customResourceLambdaReason =
    'AwsCustomResource (cross-region SSM 読み出し) が生成する CDK 管理の custom resource Lambda。実装は aws-cdk-lib 側の管理物のためポリシー / ランタイムはフレームワーク既定に従う。';
  acknowledgeRules(stack, [
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

export const applyAdminStackSuppressions = (stack: cdk.Stack): void => {
  const customResourceLambdaReason =
    'BucketDeployment / autoDeleteObjects / AwsCustomResource が生成する CDK 管理の custom resource Lambda。実装は aws-cdk-lib 側の管理物のためポリシー / ランタイムはフレームワーク既定に従う。';
  const bucketDeploymentWildcardReason =
    'BucketDeployment と autoDeleteObjects の custom resource はオブジェクトキーへ動的にアクセスするため bucket/* のワイルドカードを許容する (tidb-proxy-logs と同じ割り切り)。';
  acknowledgeRules(stack, [
    ...[
      'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
      'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole',
    ].map((finding) => ({
      id: `AwsSolutions-IAM4[${finding}]`,
      reason:
        'Lambda 実行ロールの CDK 既定 AWS 管理ポリシー。AWSLambdaVPCAccessExecutionRole は VPC 内 Lambda の ENI 管理に必要な最小権限セット。',
    })),
    {
      id: 'AwsSolutions-L1',
      reason:
        'admin-api Lambda は admin-backend の開発対象ランタイムに合わせて Node.js 22 固定。custom resource Lambda は aws-cdk-lib 既定に従う。',
    },
    {
      id: 'AwsSolutions-COG2',
      reason:
        '単一管理ユーザー運用のため MFA は初期は入れない (設計ドキュメントの決定事項)。SRP + 強パスワードポリシー (12 文字 + 4 種) + HttpOnly Cookie セッションで許容。',
    },
    {
      id: 'AwsSolutions-COG3',
      reason:
        'Cognito advanced security (Plus feature plan) は単一ユーザー運用の管理画面にはコスト過剰のため使わない。',
    },
    {
      id: 'AwsSolutions-SMG4',
      reason:
        'Cookie 暗号鍵の自動ローテーションは未対応 (ローテーションすると既存セッションが全て無効化される)。漏洩時は再デプロイで手動ローテーションする。',
    },
    {
      id: 'AwsSolutions-CFR1',
      reason: '個人用管理画面のため geo restriction は設けない。',
    },
    {
      id: 'AwsSolutions-CFR2',
      reason:
        'TODO(別PR): CloudFront への WAF 導入を検討する。認証はアプリ層のセッション Cookie で行っており、単一ユーザー運用のため初期は持たない。',
    },
    {
      id: 'AwsSolutions-CFR3',
      reason:
        '個人ブログ用途でアクセスログ用の追加バケット・コストを持たない方針 (tidb-proxy の VPC Flow Logs と同じ割り切り)。',
    },
    {
      id: 'AwsSolutions-APIG1',
      reason:
        'TODO(別PR): HTTP API ステージのアクセスログを CloudWatch Logs に出力する設定を追加する。',
    },
    {
      id: 'AwsSolutions-APIG4',
      reason:
        'HTTP API は {proxy+} ANY で Lambda にパススルーし、認証は Lambda 側のセッション Cookie (unseal + admin_sessions + jose 検証) で行う。CloudFront 経由以外の直叩きも Cookie が無ければ 401。',
    },
    {
      id: 'AwsSolutions-S1',
      reason:
        '個人ブログ用途でサーバーアクセスログ用の追加バケット・コストを持たない方針 (tidb-proxy-logs と同じ割り切り)。',
    },
    ...[
      'Action::s3:Abort*',
      'Action::s3:DeleteObject*',
      'Action::s3:GetBucket*',
      'Action::s3:GetObject*',
      'Action::s3:List*',
      'Resource::<SpaBucket48E1059F.Arn>/*',
    ].map((finding) => ({
      id: `AwsSolutions-IAM5[${finding}]`,
      reason: bucketDeploymentWildcardReason,
    })),
    {
      id: 'AwsSolutions-IAM5[Resource::<ImagesBucket1E86AFB2.Arn>/images/moments/*]',
      reason:
        'admin-api Lambda が presigned PUT URL の署名者として images/moments/ prefix 配下へ PutObject するための権限。key は投稿ごとに ULID で動的に決まるため prefix ワイルドカードが必要。',
    },
    {
      id: 'AwsSolutions-IAM5[Resource::*]',
      reason:
        'BucketDeployment の custom resource が SPA 更新時に実行する cloudfront:CreateInvalidation はリソースレベル制限非対応の API。',
    },
    {
      id: 'AwsSolutions-COG8',
      reason:
        'dev の User Pool は作り直し前提のため deletion protection を付けない (removalPolicy: DESTROY と整合)。prd は deletionProtection: true を設定済み。',
    },
    ...['<AWS::Partition>', 'aws'].map((partition) => ({
      id: `AwsSolutions-IAM5[Resource::arn:${partition}:s3:::cdk-hnb659fds-assets-${stack.account}-${stack.region}/*]`,
      reason:
        'BucketDeployment の custom resource Lambda が CDK bootstrap の asset バケットから SPA 資材を取得するための CDK 既定権限。',
    })),
    {
      id: 'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]',
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
