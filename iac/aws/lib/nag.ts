import { Aspects } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import type { IConstruct } from 'constructs';

export const applyNag = (scope: IConstruct): void => {
  Aspects.of(scope).add(new AwsSolutionsChecks({ verbose: true, reports: true }));
};
