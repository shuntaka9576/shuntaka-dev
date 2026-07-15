'use client';

import { ArticleCard } from '@/components/ArticleCard';
import { ArticleCardSkeletonList } from '@/components/ArticleCardSkeleton';
import { useSearch } from '@/components/SearchProvider';
import { useTagFilter } from '@/components/TagFilterProvider';

interface FilteredArticleListProps {
  userName: string;
  /** サーバーレンダリング済みの既定一覧（ページスライス + ページネーション） */
  children: React.ReactNode;
}

// ページ番号リストを Pagination コンポーネントと同じルールで生成する
type PageItem = number | 'ellipsis';

function buildPageItems(currentPage: number, totalPages: number): PageItem[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  const items: PageItem[] = [];
  const window = 2;
  const start = Math.max(2, currentPage - window);
  const end = Math.min(totalPages - 1, currentPage + window);
  items.push(1);
  if (start > 2) items.push('ellipsis');
  for (let p = start; p <= end; p += 1) items.push(p);
  if (end < totalPages - 1) items.push('ellipsis');
  items.push(totalPages);
  return items;
}

/** 絞り込み結果専用のページネーション（ProgressLink ではなく onClick ベース） */
function FilterPagination({
  currentPage,
  totalPages,
  onPageChange,
}: {
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}) {
  if (totalPages <= 1) return null;
  const items = buildPageItems(currentPage, totalPages);
  return (
    <nav className="mt-6 flex items-center justify-center text-sm sm:mt-8" aria-label="pagination">
      <ul className="flex items-center gap-1 sm:gap-2">
        {items.map((item, idx) =>
          item === 'ellipsis' ? (
            <li
              key={`ellipsis-${idx}`}
              className="px-1 text-[var(--color-text-muted)] sm:px-2"
              aria-hidden="true"
            >
              …
            </li>
          ) : item === currentPage ? (
            <li key={item}>
              <span
                aria-current="page"
                className="inline-flex min-h-10 min-w-10 items-center justify-center border-b-2 border-[var(--color-text)] px-2 font-medium text-[var(--color-text)] sm:px-3"
              >
                {item}
              </span>
            </li>
          ) : (
            <li key={item}>
              <button
                type="button"
                onClick={() => onPageChange(item)}
                aria-label={`page ${item}`}
                className="inline-flex min-h-10 min-w-10 items-center justify-center px-2 text-[var(--color-link)] hover:text-[var(--color-link-hover)] sm:px-3"
              >
                {item}
              </button>
            </li>
          ),
        )}
      </ul>
    </nav>
  );
}

/**
 * 表示切替の優先順:
 *   1. `searching` (?q= が有効) → SearchProvider の結果を表示 (距離メーター付き)
 *   2. `filtering` (タグ選択が 1 件以上) → TagFilterProvider の結果を表示
 *   3. どちらも無い → SSR 済みの children (通常一覧 + Pagination)
 *
 * ローディング / エラー / 0 件表示はそれぞれの provider の state から組み立てる。
 * 検索結果に関しては手動 pagination しない（API が上位 20 件を返す仕様）。
 */
export function FilteredArticleList({ userName, children }: FilteredArticleListProps) {
  const {
    filtering,
    fetchedArticles,
    loading: tagLoading,
    error: tagError,
    mode,
    filterPage,
    filteredTotalPages,
    changeMode,
    clear: clearTags,
    setFilterPage,
    retry: retryTags,
    isTagMatched,
  } = useTagFilter();

  const {
    searching,
    results,
    loading: searchLoading,
    error: searchError,
    submittedQuery,
    searchPage,
    searchTotalPages,
    clearQuery,
    retry: retrySearch,
    setSearchPage,
  } = useSearch();

  // === 検索モード（最優先） ===
  if (searching) {
    // エラー状態（初回フェッチ失敗 = results が null）
    if (searchError && results === null) {
      return (
        <div>
          <p className="text-[length:var(--fs-caption)] text-[var(--color-text-muted)]">
            検索に失敗しました。
          </p>
          <div className="mt-2 flex gap-3 text-[length:var(--fs-caption)]">
            <button
              type="button"
              onClick={retrySearch}
              className="text-[var(--color-text-muted)] underline"
            >
              再試行
            </button>
            <button
              type="button"
              onClick={clearQuery}
              className="text-[var(--color-text-muted)] underline"
            >
              検索を解除
            </button>
          </div>
        </div>
      );
    }

    if (results === null && searchLoading) {
      return <ArticleCardSkeletonList count={5} />;
    }

    const articles = results ?? [];
    if (!searchLoading && articles.length === 0) {
      return (
        <div>
          <p>「{submittedQuery}」に一致する記事はありません。</p>
          <button
            type="button"
            onClick={clearQuery}
            className="mt-2 text-[length:var(--fs-caption)] text-[var(--color-text-muted)] underline"
          >
            検索を解除
          </button>
        </div>
      );
    }

    const priorityArticleIds = new Set(
      articles
        .filter((a) => a.thumbnail)
        .slice(0, 2)
        .map((a) => a.articleId),
    );
    const wrapperClass = searchLoading ? 'pointer-events-none opacity-50' : '';

    return (
      <div>
        {searchLoading && (
          <p className="mb-2 text-[length:var(--fs-caption)] text-[var(--color-text-muted)]">
            読み込み中…
          </p>
        )}
        <div className={wrapperClass}>
          {articles.map((article) => (
            <ArticleCard
              key={article.articleId}
              article={article}
              userName={userName}
              priority={priorityArticleIds.has(article.articleId)}
              distance={article.distance}
            />
          ))}
          <FilterPagination
            currentPage={searchPage}
            totalPages={searchTotalPages}
            onPageChange={setSearchPage}
          />
        </div>
      </div>
    );
  }

  // === タグ絞り込みモード ===
  if (!filtering) return children;

  if (tagError && fetchedArticles === null) {
    return (
      <div>
        <p className="text-[length:var(--fs-caption)] text-[var(--color-text-muted)]">
          読み込みに失敗しました。
        </p>
        <button
          type="button"
          onClick={retryTags}
          className="mt-2 text-[length:var(--fs-caption)] text-[var(--color-text-muted)] underline"
        >
          再試行
        </button>
      </div>
    );
  }

  if (fetchedArticles === null && tagLoading) {
    return <ArticleCardSkeletonList count={5} />;
  }

  const articles = fetchedArticles ?? [];

  if (!tagLoading && articles.length === 0) {
    return (
      <div>
        <p>一致する記事がありません。</p>
        <div className="mt-2 flex gap-3 text-[length:var(--fs-caption)]">
          {mode === 'and' && (
            <button
              type="button"
              onClick={() => changeMode('or')}
              className="text-[var(--color-text-muted)] underline"
            >
              OR に切り替える
            </button>
          )}
          <button
            type="button"
            onClick={clearTags}
            className="text-[var(--color-text-muted)] underline"
          >
            タグを外す
          </button>
        </div>
      </div>
    );
  }

  const priorityArticleIds = new Set(
    articles
      .filter((a) => a.thumbnail)
      .slice(0, 2)
      .map((a) => a.articleId),
  );

  const wrapperClass = tagLoading ? 'pointer-events-none opacity-50' : '';

  return (
    <div>
      {tagLoading && (
        <p className="mb-2 text-[length:var(--fs-caption)] text-[var(--color-text-muted)]">
          読み込み中…
        </p>
      )}
      <div className={wrapperClass}>
        {articles.map((article) => (
          <ArticleCard
            key={article.articleId}
            article={article}
            userName={userName}
            priority={priorityArticleIds.has(article.articleId)}
            tags={(article.tags ?? []).map((path) => ({ path, matched: isTagMatched(path) }))}
          />
        ))}
        <FilterPagination
          currentPage={filterPage}
          totalPages={filteredTotalPages}
          onPageChange={setFilterPage}
        />
      </div>
    </div>
  );
}
