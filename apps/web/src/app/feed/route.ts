import RSS from 'rss';
import { getArticlesByType } from '@/lib/api';
import {
  SITE_DESCRIPTION,
  SITE_TITLE,
  SITE_URL,
  USER_NAME,
} from '@/lib/constants';

export async function GET() {
  const feed = new RSS({
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    site_url: SITE_URL,
    feed_url: `${SITE_URL}/feed`,
    language: 'ja',
  });

  const articles = await getArticlesByType(USER_NAME, 'tech');

  articles.forEach((article) => {
    feed.item({
      title: article.title,
      description: article.description,
      date: article.publishedAt ? new Date(article.publishedAt) : new Date(),
      url: `${SITE_URL}/${USER_NAME}/articles/${article.slug}`,
    });
  });

  return new Response(feed.xml(), {
    headers: {
      'Content-Type': 'application/xml',
      'Cache-Control': 's-maxage=86400, stale-while-revalidate',
    },
  });
}
