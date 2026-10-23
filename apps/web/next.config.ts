import path from 'node:path';
import { loadEnvConfig } from '@next/env';
import type { NextConfig } from 'next';

// next.config 評価時点では .env.local が未ロードのため明示的に読み込む
loadEnvConfig(process.cwd());

// モノレポのルート。standalone の出力位置 (.next/standalone/apps/web/server.js) を固定する
const repoRoot = path.join(__dirname, '../..');

const nextConfig: NextConfig = {
  // Lambda Web Functions で動かすため、server.js と必要な node_modules だけを .next/standalone に出す。
  // 包み方は iac/aws/lib/web-function-package.ts を参照
  output: 'standalone',
  outputFileTracingRoot: repoRoot,
  turbopack: { root: repoRoot },
  cacheComponents: true,
  partialPrefetching: true,
  cacheLife: {
    blog: {
      stale: 30,
      revalidate: 30,
      expire: 86400,
    },
    sitemap: {
      stale: 60,
      revalidate: 60,
      expire: 86400,
    },
  },
  // dev サーバーへ localhost 以外のオリジン (Tailscale Funnel 等) からアクセスする場合に
  // .env.local の ALLOWED_DEV_ORIGINS (カンマ区切り) で許可する。本番ビルドには影響しない
  allowedDevOrigins: process.env.ALLOWED_DEV_ORIGINS?.split(','),
  images: {
    // 画像の最適化 (sharp) は関数内で CPU を使い、同じ実行環境のほかのリクエストを待たせるため行わない。
    // 記事サムネイルは Cloudinary の署名付き URL (変換パラメータを足すと署名が壊れる)、
    // moments は事前生成済みの WebP (thumb) で、どちらも配信側でサイズが決まっている
    unoptimized: true,
  },
  experimental: {
    optimizePackageImports: ['tocbot'],
  },
  // 本番は CloudFront が /api/* を blog-api へ振り分ける。next dev では同じ経路をここで再現し、
  // ブラウザから blog-api を同一オリジンで呼べるようにする (blog-api は CORS ヘッダーを返さない)
  async rewrites() {
    if (process.env.NODE_ENV !== 'development') {
      return [];
    }
    return [
      {
        source: '/api/:path*',
        destination: `${process.env.API_URL || 'http://localhost:43003'}/:path*`,
      },
    ];
  },
  async redirects() {
    return [
      {
        source: '/who',
        destination: '/about',
        permanent: true,
      },
      {
        source: '/page/1',
        destination: '/',
        permanent: true,
      },
      {
        source: '/type/note/page/1',
        destination: '/type/note',
        permanent: true,
      },
    ];
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'X-Frame-Options',
            value: 'DENY',
          },
          {
            key: 'X-XSS-Protection',
            value: '1; mode=block',
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
