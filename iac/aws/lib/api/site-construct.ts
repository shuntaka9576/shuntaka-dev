import * as cdk from 'aws-cdk-lib';
import type * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { WebFunction } from '../web-function.js';
import { webWebFunctionCode } from '../web-function-package.js';

// 公開サイト (apex) の CloudFront。Vercel と api.<fqdn> (API Gateway) を置き換える。
// - default        → apps/web (Next.js) の Web Function
// - /_next/static/* → 同上。ファイル名にハッシュが入った immutable なアセットなので長くキャッシュする
// - /api/*         → blog-api の Web Function。/api を外して転送する
// 同一オリジンにまとめるため、ブラウザから API への CORS は不要
export class SiteConstruct extends Construct {
  constructor(
    scope: Construct,
    id: string,
    props: {
      physicalPrefix: string;
      fqdn: string;
      hostedZone: route53.IHostedZone;
      /** us-east-1 の apex 用証明書 */
      certificate: acm.ICertificate;
      webFunctionCodeBucket: s3.Bucket;
      /** Web Function の endpoint が使える実行環境の上限 */
      webFunctionMaxEnvironments: number;
      blogApi: WebFunction;
      /** next build に渡す環境変数 */
      buildEnv: Record<string, string>;
    },
  ) {
    super(scope, id);

    const siteUrl = `https://${props.fqdn}`;

    const web = new WebFunction(this, 'WebFunction', {
      functionName: `${props.physicalPrefix}-web`,
      codeBucket: props.webFunctionCodeBucket,
      code: webWebFunctionCode(props.buildEnv),
      timeoutSeconds: 30,
      maxEnvironments: props.webFunctionMaxEnvironments,
      environment: {
        // サーバー側の fetch は相対 URL を解決できないため、CloudFront 経由の API を絶対 URL で指す
        API_URL: `${siteUrl}/api`,
      },
    });

    // Web Function オリジンは always-amz-auth のみ対応。L2 の SigningBehavior には無いため L1 で作る
    const oac = new cloudfront.CfnOriginAccessControl(this, 'OriginAccessControl', {
      originAccessControlConfig: {
        name: `${props.physicalPrefix}-web-function`,
        originAccessControlOriginType: 'lambda',
        signingBehavior: 'always-amz-auth',
        signingProtocol: 'sigv4',
      },
    });

    // ページの TTL は Next.js が返す s-maxage / stale-while-revalidate に任せる。
    // App Router は同じ URL で HTML と RSC ペイロードを返し分けるので、
    // Vary に出るヘッダーをキャッシュキーに入れて混ざらないようにする
    const pageCachePolicy = new cloudfront.CachePolicy(this, 'PageCachePolicy', {
      cachePolicyName: `${props.physicalPrefix}-web-page`,
      minTtl: cdk.Duration.seconds(0),
      defaultTtl: cdk.Duration.seconds(0),
      maxTtl: cdk.Duration.days(365),
      headerBehavior: cloudfront.CacheHeaderBehavior.allowList(
        'RSC',
        'Next-Router-State-Tree',
        'Next-Router-Prefetch',
        'Next-Router-Segment-Prefetch',
      ),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });

    // blog-api のルートは /users/... /webhooks/github など接頭辞なしのため、/api を外して転送する
    const stripApiPrefixFunction = new cloudfront.Function(this, 'StripApiPrefixFunction', {
      functionName: `${props.physicalPrefix}-strip-api-prefix`,
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  request.uri = request.uri.replace(/^\\/api/, '') || '/';
  return request;
}
`),
    });

    const webOrigin = web.origin(oac.attrId);
    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `${props.physicalPrefix}-web`,
      domainNames: [props.fqdn],
      certificate: props.certificate,
      // 日本のエッジを含める (PRICE_CLASS_100 は北米 / 欧州のみ)
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      defaultBehavior: {
        origin: webOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: pageCachePolicy,
        // Host を転送すると Web Function が自分宛てと判定できず 404 を返す
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      },
      additionalBehaviors: {
        '/_next/static/*': {
          origin: webOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
        '/api/*': {
          origin: props.blogApi.origin(oac.attrId),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          // GitHub webhook (POST /api/webhooks/github) を通す
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          functionAssociations: [
            {
              function: stripApiPrefixFunction,
              eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
            },
          ],
        },
      },
    });

    web.allowInvokeFrom(distribution);
    props.blogApi.allowInvokeFrom(distribution);

    // 静的ページは s-maxage=31536000 で返るため、デプロイ後もエッジに古い内容が残る (Vercel は
    // デプロイ時にパージしていた)。endpoint が新しい revision を指した後に全体を invalidation する。
    // revision ID を物理 ID にして、apps/web の revision が変わったときだけ実行する
    const invalidation = new cr.AwsCustomResource(this, 'InvalidateOnDeploy', {
      onUpdate: {
        service: 'CloudFront',
        action: 'createInvalidation',
        parameters: {
          DistributionId: distribution.distributionId,
          InvalidationBatch: {
            CallerReference: web.revisionId,
            Paths: { Quantity: 1, Items: ['/*'] },
          },
        },
        physicalResourceId: cr.PhysicalResourceId.of(web.revisionId),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['cloudfront:CreateInvalidation'],
          resources: [distribution.distributionArn],
        }),
      ]),
    });
    invalidation.node.addDependency(web.endpoint);

    new route53.ARecord(this, 'ApexAliasRecord', {
      zone: props.hostedZone,
      target: route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(distribution)),
    });
    new route53.AaaaRecord(this, 'ApexAliasRecordIpv6', {
      zone: props.hostedZone,
      target: route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(distribution)),
    });

    new cdk.CfnOutput(this, 'DistributionDomainName', {
      value: distribution.distributionDomainName,
    });
  }
}
