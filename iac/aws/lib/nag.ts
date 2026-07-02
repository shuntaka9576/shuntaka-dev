import { Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import type { IConstruct } from 'constructs';

export const applyNag = (scope: IConstruct): void => {
  Validations.of(scope).addPlugins(new AwsSolutionsChecks(scope, { verbose: true }));
};
