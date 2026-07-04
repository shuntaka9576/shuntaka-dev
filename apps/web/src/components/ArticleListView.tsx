import { ArticleCard } from '@/components/ArticleCard';
import { BaseLayout } from '@/components/BaseLayout';
import { FilteredArticleList } from '@/components/FilteredArticleList';
import { PageReady } from '@/components/PageReady';
import { Pagination } from '@/components/Pagination';
import { TagFilterControls } from '@/components/TagFilterControls';
import { TagFilterHeaderToggle } from '@/components/TagFilterHeaderToggle';
import { TagFilterProvider } from '@/components/TagFilterProvider';
import { getArticlesByType } from '@/lib/api';
import { ARTICLES_PER_PAGE, USER_NAME } from '@/lib/constants';

interface ArticleListViewProps {
  type: 'tech' | 'note';
  currentTab: 'tech' | 'note';
  page: number;
  baseHref: string;
}

export async function ArticleListView({ type, currentTab, page, baseHref }: ArticleListViewProps) {
  let articles: Awaited<ReturnType<typeof getArticlesByType>>['articles'] = [];
  let error: string | null = null;

  try {
    // タグ絞り込みはクライアントサイドフィルタのため type 単位で全件取得し、
    // 既定表示のページスライスはサーバー側で行う
    const result = await getArticlesByType(USER_NAME, type, { perPage: 'all' });
    articles = result.articles;
  } catch (e) {
    error = e instanceof Error ? e.message : 'Failed to fetch articles';
  }

  if (error) {
    return (
      <BaseLayout showTypeHeader currentTab={currentTab}>
        <main className="w-full">
          <div className="max-w-[var(--layout-list-max)]">
            <p className="text-[var(--color-danger-border)]">{error}</p>
          </div>
          <PageReady />
        </main>
      </BaseLayout>
    );
  }

  const visible = articles.slice((page - 1) * ARTICLES_PER_PAGE, page * ARTICLES_PER_PAGE);
  const totalPages = Math.ceil(articles.length / ARTICLES_PER_PAGE);
  const priorityArticleIds = new Set(
    visible
      .filter((a) => a.thumbnail)
      .slice(0, 2)
      .map((a) => a.articleId),
  );

  return (
    <TagFilterProvider
      articles={articles}
      tagRoot={type === 'tech' ? 'tech' : 'misc'}
      page={page}
      baseHref={baseHref}
    >
      <BaseLayout showTypeHeader currentTab={currentTab} typeHeaderEnd={<TagFilterHeaderToggle />}>
        <main className="w-full">
          <div className="max-w-[var(--layout-list-max)]">
            <TagFilterControls />
            <FilteredArticleList userName={USER_NAME}>
              {visible.length === 0 ? (
                <p>No articles found.</p>
              ) : (
                <>
                  {visible.map((article) => (
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
            </FilteredArticleList>
          </div>
          <PageReady />
        </main>
      </BaseLayout>
    </TagFilterProvider>
  );
}
