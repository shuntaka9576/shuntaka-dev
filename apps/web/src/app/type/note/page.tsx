import { ArticleCard } from '@/components/ArticleCard';
import { BaseLayout } from '@/components/BaseLayout';
import { PageReady } from '@/components/PageReady';
import { getArticlesByType } from '@/lib/api';

const USER_NAME = process.env.NEXT_PUBLIC_USER_NAME || 'shuntaka';

export default async function NotePage() {
  let articles: Awaited<ReturnType<typeof getArticlesByType>> = [];
  let error: string | null = null;

  try {
    articles = await getArticlesByType(USER_NAME, 'note');
  } catch (e) {
    error = e instanceof Error ? e.message : 'Failed to fetch articles';
  }

  const priorityArticleIds = new Set(
    articles
      .filter((a) => a.thumbnail)
      .slice(0, 2)
      .map((a) => a.articleId),
  );

  return (
    <BaseLayout showTypeHeader currentTab="note">
      <main className="w-full">
        <div className="max-w-[var(--layout-list-max)]">
          {error ? (
            <p className="text-[var(--color-danger-border)]">{error}</p>
          ) : articles.length === 0 ? (
            <p>No articles found.</p>
          ) : (
            articles.map((article) => (
              <ArticleCard
                key={article.articleId}
                article={article}
                userName={USER_NAME}
                priority={priorityArticleIds.has(article.articleId)}
              />
            ))
          )}
        </div>
        <PageReady />
      </main>
    </BaseLayout>
  );
}
