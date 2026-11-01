// cspell:ignore ai
import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/constants';

// `__usage_ai-training` は AI 学習への利用意向（Internet-Draft。まだ標準ではない）。
// 検索ボット向けのクロール規則（先頭の `*` グループ）とは独立している。
// https://datatracker.ietf.org/doc/draft-kelley-aipref-training-preference-signal/
export default function robots(): MetadataRoute.Robots {
  return {
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
  };
}
