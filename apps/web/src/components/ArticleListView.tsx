import { ActiveFilterBar } from '@/components/ActiveFilterBar';
import { ArticleCard } from '@/components/ArticleCard';
import { BaseLayout } from '@/components/BaseLayout';
import { FilteredArticleList } from '@/components/FilteredArticleList';
import { PageReady } from '@/components/PageReady';
import { Pagination } from '@/components/Pagination';
import { SearchModal } from '@/components/SearchModal';
import { SearchProvider } from '@/components/SearchProvider';
import { SearchTriggerButton } from '@/components/SearchTriggerButton';
import { TagFilterModal } from '@/components/TagFilterModal';
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
      <BaseLayout showTypeHeader currentTab="posts" narrow>
        <main className="w-full">
          <p className="text-[var(--color-danger-border)]">{error}</p>
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
      <SearchProvider userName={USER_NAME}>
        <BaseLayout showTypeHeader currentTab="posts" narrow>
          <main className="w-full">
            <ActiveFilterBar />
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
            <PageReady />
          </main>
          <SearchTriggerButton />
          <SearchModal userName={USER_NAME} defaultArticles={articles} />
          <TagFilterModal />
        </BaseLayout>
      </SearchProvider>
    </TagFilterProvider>
  );
}
