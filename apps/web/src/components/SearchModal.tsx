'use client';

import { Fragment, useCallback, useEffect, useRef } from 'react';
import { ArticleCard } from '@/components/ArticleCard';
import { ArticleCardSkeletonList } from '@/components/ArticleCardSkeleton';
import { useSearch } from '@/components/SearchProvider';
import { SearchInput } from '@/components/SearchInput';
import { useTagFilter } from '@/components/TagFilterProvider';
import type { ArticleSummary, SearchArticleResult } from '@/lib/api';
import { useNavigationProgress } from '@/components/NavigationProgressProvider';
import { useFullScreenModal } from '@/lib/useFullScreenModal';

interface SearchModalProps {
  userName: string;
  /** SSR で渡された現在ページの記事一覧。未検索・未絞り込みのときに表示する */
  defaultArticles: ArticleSummary[];
}

/** Lucide "tag" 相当 */
function TagIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z" />
      <circle cx="7.5" cy="7.5" r="0.5" fill="currentColor" />
    </svg>
  );
}

/** Lucide "arrow-left" 相当 */
function BackIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m12 19-7-7 7-7" />
      <path d="M19 12H5" />
    </svg>
  );
}

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

function ModalPagination({
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
    <nav
      className="font-latin-ui mt-6 flex items-center justify-center text-sm sm:mt-8"
      aria-label="pagination"
    >
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
 * 検索専用の全画面モーダル。ページ chrome を覆い、SearchInput + 記事一覧に集中する。
 * タグ絞り込みは別モーダル (`TagFilterModal`) で扱う。両者は provider を共有するので
 * ここに表示される「記事一覧」は、検索・タグ絞り込みの合成結果を反映する。
 *
 * 記事は既存の `ArticleCard` (thumbnail 付き) をそのまま使い、ページ本体と同じ見た目を保つ。
 * 検索・タグ絞り込みの結果にも onClick ベースのページネーションを表示する。
 */
export function SearchModal({ userName, defaultArticles }: SearchModalProps) {
  const {
    modalOpen,
    query,
    submittedQuery,
    searching,
    results,
    loading: searchLoading,
    error: searchError,
    searchPage,
    searchTotalPages,
    setQuery,
    submitNow,
    clearQuery,
    closeModal,
    setSearchPage,
  } = useSearch();

  const {
    selected,
    mode,
    filtering,
    fetchedArticles,
    loading: tagLoading,
    filterPage,
    filteredTotalPages,
    isTagMatched,
    toggleTag,
    changeMode,
    clear: clearTags,
    setFilterPage,
    openTagModal,
  } = useTagFilter();

  const { startProgress, doneProgress } = useNavigationProgress();
  const { containerStyle } = useFullScreenModal(modalOpen, closeModal);

  const listLoading = (searching && searchLoading) || (filtering && tagLoading);

  const prevLoadingRef = useRef(false);
  useEffect(() => {
    if (listLoading && !prevLoadingRef.current) startProgress();
    if (!listLoading && prevLoadingRef.current) doneProgress();
    prevLoadingRef.current = listLoading;
  }, [listLoading, startProgress, doneProgress]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const handlePageChange = useCallback(
    (setter: (page: number) => void) => (page: number) => {
      setter(page);
      scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    },
    [],
  );

  if (!modalOpen) return null;

  const articleList: (ArticleSummary | SearchArticleResult)[] = searching
    ? (results ?? [])
    : filtering
      ? (fetchedArticles ?? [])
      : defaultArticles;

  const priorityArticleIds = new Set(
    articleList
      .filter((a) => a.thumbnail)
      .slice(0, 2)
      .map((a) => a.articleId),
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="記事を検索"
      className="fixed inset-x-0 z-50 flex flex-col bg-[var(--color-bg)]"
      style={containerStyle}
    >
      {/* Top fixed: SearchInput + tag toggle + close */}
      <div className="shrink-0 border-b border-[var(--color-border-subtle)] px-4 pt-3 pb-3 sm:px-6">
        <div className="mx-auto flex w-full max-w-[calc(var(--layout-list-max)+4rem)] items-center gap-2">
          <div className="min-w-0 flex-1">
            <SearchInput
              value={query}
              onChange={setQuery}
              onClear={clearQuery}
              onSubmit={submitNow}
              loading={searchLoading}
              placeholder={filtering ? '選択中のタグ内を検索' : '記事を検索'}
              autoFocus
            />
          </div>
          <button
            type="button"
            onClick={openTagModal}
            aria-label="タグで絞り込む"
            className={`inline-flex h-9 shrink-0 items-center gap-1 rounded-[var(--radius-sm)] px-2 ${
              filtering ? 'text-[var(--color-text)]' : 'text-[var(--color-text-muted)]'
            }`}
          >
            <TagIcon />
            {filtering && (
              <span className="font-latin-ui text-[length:var(--fs-caption)] font-medium">
                {selected.length}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={closeModal}
            aria-label="戻る"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-full)] text-[var(--color-text-muted)]"
          >
            <BackIcon />
          </button>
        </div>

        {/* 選択タグ chips — SearchModal 内でも現在の絞り込み状態が見える */}
        {selected.length > 0 && (
          <div className="mx-auto mt-3 flex w-full max-w-[calc(var(--layout-list-max)+4rem)] flex-wrap items-center gap-x-2 gap-y-1 text-[length:var(--fs-caption)]">
            {selected.map((tag, i) => (
              <Fragment key={tag}>
                {i > 0 && (
                  <span className="text-[var(--color-text-muted)]" aria-hidden="true">
                    {mode === 'and' ? 'AND' : 'OR'}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => toggleTag(tag)}
                  aria-label={`${tag} の絞り込みを解除`}
                  className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--color-text)] px-2 py-0.5 text-[var(--color-text)]"
                >
                  #{tag}
                  <span aria-hidden="true">×</span>
                </button>
              </Fragment>
            ))}
            {selected.length >= 2 && (
              <button
                type="button"
                onClick={() => changeMode(mode === 'and' ? 'or' : 'and')}
                className="text-[var(--color-text-muted)] underline"
              >
                {mode === 'and' ? '→ OR' : '→ AND'}
              </button>
            )}
            <button
              type="button"
              onClick={clearTags}
              className="text-[var(--color-text-muted)] underline"
            >
              クリア
            </button>
          </div>
        )}
      </div>

      {/* Scrollable body */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 pt-4 pb-8 sm:px-6">
        <div className="mx-auto w-full max-w-[var(--layout-list-max)]">
          {searchError && searching && results === null ? (
            <p className="text-[length:var(--fs-caption)] text-[var(--color-text-muted)]">
              検索に失敗しました
            </p>
          ) : listLoading ? (
            <ArticleCardSkeletonList count={5} />
          ) : articleList.length === 0 ? (
            <p>
              {searching ? `「${submittedQuery}」に一致する記事がありません` : '記事がありません'}
            </p>
          ) : (
            <>
              {articleList.map((article) => (
                <ArticleCard
                  key={article.articleId}
                  article={article}
                  userName={userName}
                  priority={priorityArticleIds.has(article.articleId)}
                  distance={(article as SearchArticleResult).distance}
                  tags={
                    filtering
                      ? (article.tags ?? []).map((path) => ({
                          path,
                          matched: isTagMatched(path),
                        }))
                      : undefined
                  }
                />
              ))}
              {searching && searchTotalPages > 1 && (
                <ModalPagination
                  currentPage={searchPage}
                  totalPages={searchTotalPages}
                  onPageChange={handlePageChange(setSearchPage)}
                />
              )}
              {!searching && filtering && filteredTotalPages > 1 && (
                <ModalPagination
                  currentPage={filterPage}
                  totalPages={filteredTotalPages}
                  onPageChange={handlePageChange(setFilterPage)}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
