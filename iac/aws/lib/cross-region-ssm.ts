import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import type { Construct } from 'constructs';

// SSM Parameter Store はリージョンローカルのため、別リージョンのパラメータは
// AwsCustomResource (deploy 時に GetParameter を実行) で読む。値はスタック更新
// まで固定される (blog-api-construct の lookupSecureString と同じ性質)。
export const readCrossRegionParameter = (
  scope: Construct,
  id: string,
  input: { parameterName: string; region: string },
): string => {
  const lookup = new cr.AwsCustomResource(scope, id, {
    onUpdate: {
      service: 'SSM',
      action: 'GetParameter',
      parameters: { Name: input.parameterName },
      region: input.region,
      physicalResourceId: cr.PhysicalResourceId.of(`${input.region}:${input.parameterName}`),
    },
    policy: cr.AwsCustomResourcePolicy.fromStatements([
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [
          `arn:aws:ssm:${input.region}:${cdk.Aws.ACCOUNT_ID}:parameter${input.parameterName}`,
        ],
      }),
    ]),
  });
  return lookup.getResponseField('Parameter.Value');
};
