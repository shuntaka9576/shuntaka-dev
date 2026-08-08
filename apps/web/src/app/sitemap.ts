import type { MetadataRoute } from 'next';
import { cacheLife } from 'next/cache';
import { getCachedArticles } from '@/lib/cachedApi';
import { SITE_URL, USER_NAME } from '@/lib/constants';

function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

async function getSitemap(): Promise<MetadataRoute.Sitemap> {
  'use cache';
  cacheLife('sitemap');

  const { articles } = await getCachedArticles(USER_NAME, { perPage: 'all' });

  const articleUrls: MetadataRoute.Sitemap = articles.map((article) => ({
    url: `${SITE_URL}/${USER_NAME}/articles/${article.slug}`,
    lastModified: formatDate(article.updatedAt ? new Date(article.updatedAt) : new Date()),
    changeFrequency: 'yearly',
    priority: 0.5,
  }));

  return [
    {
      url: SITE_URL,
      lastModified: formatDate(new Date()),
      changeFrequency: 'daily',
      priority: 1,
    },
    ...articleUrls,
  ];
}

export default function sitemap(): Promise<MetadataRoute.Sitemap> {
  return getSitemap();
}
