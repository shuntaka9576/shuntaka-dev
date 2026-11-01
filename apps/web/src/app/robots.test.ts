// cspell:ignore ai
import { createRequire } from 'node:module';
import { describe, expect, test } from 'bun:test';
import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/constants';
import robots from './robots';

const require = createRequire(import.meta.url);
// Next.js が /robots.txt の本文を組み立てる関数。
const { resolveRobots } =
  require('next/dist/build/webpack/loaders/metadata/resolve-route-data.js') as {
    resolveRobots: (data: MetadataRoute.Robots) => string;
  };

describe('robots', () => {
  test('検索ボットの規則を変えずに AI 学習の opt-in を足す', () => {
    const result = robots();

    expect(result).toEqual({
      rules: [
        {
          userAgent: '*',
          allow: '/',
          disallow: ['/api/', '/_next/'],
        },
        {
          userAgent: '__usage_ai-training',
          allow: '/',
        },
      ],
      sitemap: `${SITE_URL}/sitemap.xml`,
    });
  });

  test('robots.txt の本文は * グループ、学習 opt-in、Sitemap の順', () => {
    const body = resolveRobots(robots());

    expect(body).toBe(
      [
        'User-Agent: *',
        'Allow: /',
        'Disallow: /api/',
        'Disallow: /_next/',
        '',
        'User-Agent: __usage_ai-training',
        'Allow: /',
        '',
        `Sitemap: ${SITE_URL}/sitemap.xml`,
      ].join('\n') + '\n',
    );
  });
});
