// cspell:ignore ai
import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/constants';

// `__usage_ai-training` は AI 学習への利用意向を示すポリシートークン。
// 検索ボット向けのクロール規則（先頭の `*` グループ）とは独立している。
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
