import type { Metadata } from 'next';
import Image from 'next/image';
import { notFound } from 'next/navigation';
import { ArticleContent } from '@/components/ArticleContent';
import { BaseLayout } from '@/components/BaseLayout';
import { ArticleJsonLd } from '@/components/JsonLd';
import { TableOfContents } from '@/components/TableOfContents';
import { getArticleBySlug } from '@/lib/api';
import { SITE_URL } from '@/lib/constants';

export const dynamicParams = true;
export const revalidate = 30;

export async function generateStaticParams() {
  // ビルド時は静的生成しない（リクエスト時にオンデマンドで生成）
  return [];
}

interface ArticlePageProps {
  params: Promise<{
    userName: string;
    slug: string;
  }>;
}

export async function generateMetadata({ params }: ArticlePageProps): Promise<Metadata> {
  const { userName, slug } = await params;
  const article = await getArticleBySlug(userName, slug);

  if (!article) {
    return { title: 'Article Not Found' };
  }

  // 旧 type=note 相当。misc ルートのタグを持つ記事はサイト共通画像 + 小カードにする
  const isMisc = article.tags.some((tag) => tag === 'misc' || tag.startsWith('misc/'));
  const ogImage = isMisc
    ? 'https://res.cloudinary.com/dkerzyk09/image/upload/v1767101809/blog/og/shuntaka.png'
    : (article.thumbnail ?? article.ogpUrl);

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
      card: isMisc ? 'summary' : 'summary_large_image',
      images: [ogImage],
    },
  };
}

function formatDate(dateString: string | null): string {
  if (!dateString) return '';
  const date = new Date(dateString);
  const formatter = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('month')}/${get('day')} ${get('hour')}:${get('minute')} ${get('year')}`;
}

export default async function ArticlePage({ params }: ArticlePageProps) {
  const { userName, slug } = await params;
  const article = await getArticleBySlug(userName, slug);

  if (!article) {
    notFound();
  }

  const articleUrl = `${SITE_URL}/${userName}/articles/${slug}`;
  const contentHtml = article.contentHtml ?? '';
  // 目次対象の見出し（h1-h3）が無い記事はサイドバーを出さず本文を中央に寄せる
  const hasToc = /<h[1-3][\s>]/.test(contentHtml);

  return (
    <>
      <ArticleJsonLd
        title={article.title}
        description={article.description}
        publishedAt={article.publishedAt}
        updatedAt={article.updatedAt}
        authorName={userName}
        url={articleUrl}
        imageUrl={article.thumbnail ?? article.ogpUrl}
      />
      <BaseLayout>
        <div className="article-header">
          <div className="article-title">{article.title}</div>
          <div className="article-info">
            <div className="article-time">
              <p>{formatDate(article.publishedAt)}</p>
              <p>{formatDate(article.updatedAt)}</p>
            </div>
          </div>
        </div>
        <div className={hasToc ? 'article-body' : 'article-body article-body-centered'}>
          <article className="article-content">
            {article.thumbnail && (
              <Image
                src={article.thumbnail}
                alt={article.title}
                width={800}
                height={450}
                className="article-thumbnail"
                priority
                sizes="(max-width: 768px) 100vw, 800px"
              />
            )}
            <div className="article-content-wrapper">
              <ArticleContent html={contentHtml} />
            </div>
          </article>
          {hasToc && (
            <aside className="right-sidebar">
              <TableOfContents />
            </aside>
          )}
        </div>
      </BaseLayout>
    </>
  );
}
