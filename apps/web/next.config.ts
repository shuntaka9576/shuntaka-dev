import { loadEnvConfig } from '@next/env';
import type { NextConfig } from 'next';

// next.config 評価時点では .env.local が未ロードのため明示的に読み込む
loadEnvConfig(process.cwd());

const nextConfig: NextConfig = {
  // dev サーバーへ localhost 以外のオリジン (Tailscale Funnel 等) からアクセスする場合に
  // .env.local の ALLOWED_DEV_ORIGINS (カンマ区切り) で許可する。本番ビルドには影響しない
  allowedDevOrigins: process.env.ALLOWED_DEV_ORIGINS?.split(','),
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'res.cloudinary.com',
        pathname: '/dkerzyk09/**',
      },
      // moments の写真配信ドメイン（prd / dev）
      {
        protocol: 'https',
        hostname: 'images.shuntaka.dev',
        pathname: '/images/moments/**',
      },
      {
        protocol: 'https',
        hostname: 'images.shuntaka.tech',
        pathname: '/images/moments/**',
      },
    ],
  },
  experimental: {
    optimizePackageImports: ['tocbot'],
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
