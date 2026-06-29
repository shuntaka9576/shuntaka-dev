import * as cdk from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { getProxyConfig } from '../lib/config.js';
import { applyNag } from '../lib/nag.js';
import { applyTidbProxySuppressions } from '../lib/nag-suppressions.js';
import { TidbProxyStack } from '../lib/proxy/tidb-proxy-stack.js';

describe('TidbProxyStack', () => {
  it('snapshot', () => {
    const app = new cdk.App();
    const proxyConfig = getProxyConfig();
    const stack = new TidbProxyStack(app, 'TestTidbProxyStack', {
      proxyConfig,
      env: {
        account: '123456789012',
        region: 'ap-northeast-1',
      },
    });

    applyNag(stack);
    applyTidbProxySuppressions(stack);

    const nagErrors = Annotations.fromStack(stack).findError(
      '*',
      Match.stringLikeRegexp('AwsSolutions-.*'),
    );
    expect(nagErrors).toEqual([]);

    const template = Template.fromStack(stack);
    expect(template.toJSON()).toMatchSnapshot();
  });
});
