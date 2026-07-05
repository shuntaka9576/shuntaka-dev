'use client';

import { ArticleCard } from '@/components/ArticleCard';
import { useTagFilter } from '@/components/TagFilterProvider';
import { toRelativeTags } from '@/lib/tagFilter';

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
 * 絞り込みなしのときはサーバーレンダリング済みの children をそのまま表示し、
 * 絞り込み中だけクライアント側でヒット記事に差し替える。
 *
 * loading 中は既存一覧の opacity を下げ、"読み込み中…" テキストを表示する。
 * エラー時はミュートテキストと再試行ボタンを表示する。
 */
export function FilteredArticleList({ userName, children }: FilteredArticleListProps) {
  const {
    filtering,
    fetchedArticles,
    loading,
    error,
    mode,
    filterPage,
    filteredTotalPages,
    tagRoot,
    changeMode,
    clear,
    setFilterPage,
    retry,
    isTagMatched,
  } = useTagFilter();

  if (!filtering) return children;

  // エラー状態（初回フェッチ失敗 = fetchedArticles が null の場合）
  if (error && fetchedArticles === null) {
    return (
      <div>
        <p className="text-[length:var(--fs-caption)] text-[var(--color-text-muted)]">
          読み込みに失敗しました。
        </p>
        <button
          type="button"
          onClick={retry}
          className="mt-2 text-[length:var(--fs-caption)] text-[var(--color-text-muted)] underline"
        >
          再試行
        </button>
      </div>
    );
  }

  // 初回フェッチ中（まだ記事がない）
  if (fetchedArticles === null && loading) {
    return (
      <p className="text-[length:var(--fs-caption)] text-[var(--color-text-muted)]">読み込み中…</p>
    );
  }

  const articles = fetchedArticles ?? [];

  // フィルタ結果 0 件
  if (!loading && articles.length === 0) {
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
            onClick={clear}
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

  // ページ変更時または次フェッチ中は一覧を薄く表示する
  const wrapperClass = loading ? 'pointer-events-none opacity-50' : '';

  return (
    <div>
      {loading && (
        <p className="mb-2 text-[length:var(--fs-caption)] text-[var(--color-text-muted)]">
          読み込み中…
        </p>
      )}
      <div className={wrapperClass}>
        {articles.map((article) => {
          const relativeTags = toRelativeTags(article.tags ?? [], tagRoot);
          return (
            <ArticleCard
              key={article.articleId}
              article={article}
              userName={userName}
              priority={priorityArticleIds.has(article.articleId)}
              tags={relativeTags.map((path) => ({ path, matched: isTagMatched(path) }))}
            />
          );
        })}
        <FilterPagination
          currentPage={filterPage}
          totalPages={filteredTotalPages}
          onPageChange={setFilterPage}
        />
      </div>
    </div>
  );
}
