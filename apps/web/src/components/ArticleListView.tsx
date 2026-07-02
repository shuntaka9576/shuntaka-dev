import { ArticleCard } from '@/components/ArticleCard';
import { BaseLayout } from '@/components/BaseLayout';
import { PageReady } from '@/components/PageReady';
import { Pagination } from '@/components/Pagination';
import { getArticlesByType } from '@/lib/api';
import { USER_NAME } from '@/lib/constants';

interface ArticleListViewProps {
  type: 'tech' | 'note';
  currentTab: 'tech' | 'note';
  page: number;
  baseHref: string;
}

const PER_PAGE = 10;

export async function ArticleListView({ type, currentTab, page, baseHref }: ArticleListViewProps) {
  let articles: Awaited<ReturnType<typeof getArticlesByType>>['articles'] = [];
  let totalPages = 1;
  let error: string | null = null;

  try {
    const result = await getArticlesByType(USER_NAME, type, { page, perPage: PER_PAGE });
    articles = result.articles;
    totalPages = result.totalPages;
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
    <BaseLayout showTypeHeader currentTab={currentTab}>
      <main className="w-full">
        <div className="max-w-[var(--layout-list-max)]">
          {error ? (
            <p className="text-[var(--color-danger-border)]">{error}</p>
          ) : articles.length === 0 ? (
            <p>No articles found.</p>
          ) : (
            <>
              {articles.map((article) => (
                <ArticleCard
                  key={article.articleId}
                  article={article}
                  userName={USER_NAME}
                  priority={priorityArticleIds.has(article.articleId)}
                />
              ))}
              <Pagination currentPage={page} totalPages={totalPages} baseHref={baseHref} />
            </>
          )}
        </div>
        <PageReady />
      </main>
    </BaseLayout>
  );
}
