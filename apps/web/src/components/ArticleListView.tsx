import { ArticleCard } from '@/components/ArticleCard';
import { BaseLayout } from '@/components/BaseLayout';
import { FilteredArticleList } from '@/components/FilteredArticleList';
import { PageReady } from '@/components/PageReady';
import { Pagination } from '@/components/Pagination';
import { TagFilterControls } from '@/components/TagFilterControls';
import { TagFilterHeaderToggle } from '@/components/TagFilterHeaderToggle';
import { TagFilterProvider } from '@/components/TagFilterProvider';
import { getArticles, getTagFacets } from '@/lib/api';
import { ARTICLES_PER_PAGE, USER_NAME } from '@/lib/constants';

interface ArticleListViewProps {
  page: number;
  baseHref: string;
}

export async function ArticleListView({ page, baseHref }: ArticleListViewProps) {
  let articles: Awaited<ReturnType<typeof getArticles>>['articles'] = [];
  let totalPages = 1;
  let initialFacets: Awaited<ReturnType<typeof getTagFacets>>['facets'] = [];
  let error: string | null = null;

  try {
    // 現在ページの記事と全体のファセットを並列取得する
    // perPage=all の全件フェッチはやめ、1ページ分のみ取得する
    const [pageResult, facetsResult] = await Promise.all([
      getArticles(USER_NAME, { page, perPage: ARTICLES_PER_PAGE }),
      getTagFacets(USER_NAME),
    ]);
    articles = pageResult.articles;
    totalPages = pageResult.totalPages;
    initialFacets = facetsResult.facets;
  } catch (e) {
    error = e instanceof Error ? e.message : 'Failed to fetch articles';
  }

  if (error) {
    return (
      <BaseLayout showTypeHeader currentTab="posts">
        <main className="w-full">
          <div className="max-w-[var(--layout-list-max)]">
            <p className="text-[var(--color-danger-border)]">{error}</p>
          </div>
          <PageReady />
        </main>
      </BaseLayout>
    );
  }

  const priorityArticleIds = new Set(
    articles
      .filter((a) => a.thumbnail)
      .slice(0, 2)
      .map((a) => a.articleId),
  );

  return (
    <TagFilterProvider
      userName={USER_NAME}
      initialFacets={initialFacets}
      initialTotalPages={totalPages}
      page={page}
      baseHref={baseHref}
    >
      <BaseLayout showTypeHeader currentTab="posts" typeHeaderEnd={<TagFilterHeaderToggle />}>
        <main className="w-full">
          <div className="max-w-[var(--layout-list-max)]">
            <TagFilterControls />
            <FilteredArticleList userName={USER_NAME}>
              {articles.length === 0 ? (
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
            </FilteredArticleList>
          </div>
          <PageReady />
        </main>
      </BaseLayout>
    </TagFilterProvider>
  );
}
