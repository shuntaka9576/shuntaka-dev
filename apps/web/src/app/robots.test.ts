// cspell:ignore ai
import { describe, expect, test } from 'bun:test';
import { SITE_URL } from '@/lib/constants';
import robots from './robots';

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
});
