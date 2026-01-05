import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { BaseLayout } from '@/components/BaseLayout';
import { ClientTime } from '@/components/ClientTime';
import { TableOfContents } from '@/components/TableOfContents';
import { getArticleBySlug, getArticlesByType } from '@/lib/api';
import { SITE_URL, USER_NAME } from '@/lib/constants';

export const dynamicParams = true;
export const revalidate = 30;

export async function generateStaticParams() {
  const techArticles = await getArticlesByType(USER_NAME, 'tech');
  const noteArticles = await getArticlesByType(USER_NAME, 'note');
  const articles = [...techArticles, ...noteArticles];

  return articles.map((article) => ({
    userName: USER_NAME,
    slug: article.slug,
  }));
}

interface ArticlePageProps {
  params: Promise<{
    userName: string;
    slug: string;
  }>;
}

export async function generateMetadata({
  params,
}: ArticlePageProps): Promise<Metadata> {
  const { userName, slug } = await params;
  const article = await getArticleBySlug(userName, slug);

  if (!article) {
    return { title: 'Article Not Found' };
  }

  const ogImage = article.thumbnail ?? article.ogpUrl;

  return {
    title: article.title,
    description: article.description,
    openGraph: {
      title: article.title,
      description: article.description,
      type: 'article',
      url: `${SITE_URL}/${userName}/articles/${slug}`,
      siteName: new URL(SITE_URL).hostname,
      images: [{ url: ogImage }],
    },
    twitter: {
      card: 'summary_large_image',
    },
  };
}

function formatDate(dateString: string | null): string {
  if (!dateString) return '';
  const date = new Date(dateString);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const year = date.getFullYear();
  return `${month}/${day} ${hours}:${minutes} ${year}`;
}

export default async function ArticlePage({ params }: ArticlePageProps) {
  const { userName, slug } = await params;
  const article = await getArticleBySlug(userName, slug);
  const isrTime = new Date().toLocaleTimeString('ja-JP');

  if (!article) {
    notFound();
  }

  return (
    <BaseLayout>
      {/* ISR動作確認用 - 本番では削除 */}
      <div className="fixed bottom-4 right-4 bg-black/80 text-white p-3 rounded-lg text-sm font-mono z-50">
        <div>ISR生成: {isrTime}</div>
        <div>
          Client: <ClientTime />
        </div>
      </div>
      <div className="article-header">
        <div className="article-title">{article.title}</div>
        <div className="article-info">
          <div className="article-time">
            <p>{formatDate(article.publishedAt)}</p>
            <p>{formatDate(article.updatedAt)}</p>
          </div>
        </div>
      </div>
      <div className="article-body">
        <article className="article-content">
          {article.thumbnail && (
            <img
              src={article.thumbnail}
              alt={article.title}
              className="article-thumbnail"
            />
          )}
          <div className="article-content-wrapper">
            <div
              className="prose prose-lg max-w-none"
              dangerouslySetInnerHTML={{ __html: article.contentHtml ?? '' }}
            />
          </div>
        </article>
        <aside className="right-sidebar">
          <TableOfContents />
        </aside>
      </div>
    </BaseLayout>
  );
}
