import type { MetadataRoute } from 'next';
import { getArticlesByType } from '@/lib/api';
import { SITE_URL, USER_NAME } from '@/lib/constants';

export const revalidate = 60;

function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [techArticles, noteArticles] = await Promise.all([
    getArticlesByType(USER_NAME, 'tech'),
    getArticlesByType(USER_NAME, 'note'),
  ]);

  const articles = [...techArticles, ...noteArticles];

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
