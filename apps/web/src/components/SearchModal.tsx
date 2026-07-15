'use client';

import { Fragment } from 'react';
import { ArticleCard } from '@/components/ArticleCard';
import { ArticleCardSkeletonList } from '@/components/ArticleCardSkeleton';
import { Pagination } from '@/components/Pagination';
import { useSearch } from '@/components/SearchProvider';
import { SearchInput } from '@/components/SearchInput';
import { useTagFilter } from '@/components/TagFilterProvider';
import type { ArticleSummary, SearchArticleResult } from '@/lib/api';
import { useFullScreenModal } from '@/lib/useFullScreenModal';

interface SearchModalProps {
  userName: string;
  /** SSR で渡された現在ページの記事一覧。未検索・未絞り込みのときに表示する */
  defaultArticles: ArticleSummary[];
  /** default 一覧の現在ページ番号 */
  page: number;
  /** default 一覧の総ページ数 */
  totalPages: number;
  /** Pagination の baseHref */
  baseHref: string;
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

/** Lucide "x" 相当 */
function CloseIcon() {
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
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

/**
 * 検索専用の全画面モーダル。ページ chrome を覆い、SearchInput + 記事一覧に集中する。
 * タグ絞り込みは別モーダル (`TagFilterModal`) で扱う。両者は provider を共有するので
 * ここに表示される「記事一覧」は、検索・タグ絞り込みの合成結果を反映する。
 *
 * 記事は既存の `ArticleCard` (thumbnail 付き) をそのまま使い、ページ本体と同じ見た目を保つ。
 * 未検索・未絞り込みのときだけ既存の `Pagination` を出す (検索・タグ結果はページングなし)。
 */
export function SearchModal({
  userName,
  defaultArticles,
  page,
  totalPages,
  baseHref,
}: SearchModalProps) {
  const {
    modalOpen,
    query,
    submittedQuery,
    searching,
    results,
    loading: searchLoading,
    error: searchError,
    setQuery,
    submitNow,
    clearQuery,
    closeModal,
  } = useSearch();

  const {
    selected,
    mode,
    filtering,
    fetchedArticles,
    loading: tagLoading,
    isTagMatched,
    toggleTag,
    changeMode,
    clear: clearTags,
    openTagModal,
  } = useTagFilter();

  const { containerStyle } = useFullScreenModal(modalOpen, closeModal);

  if (!modalOpen) return null;

  // 表示する記事一覧 (優先順: 検索 → タグ絞り込み → デフォルト)
  const articleList: (ArticleSummary | SearchArticleResult)[] = searching
    ? (results ?? [])
    : filtering
      ? (fetchedArticles ?? [])
      : defaultArticles;
  const listLoading = (searching && searchLoading) || (filtering && tagLoading);
  const showPagination = !searching && !filtering && totalPages > 1;

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
              <span className="text-[length:var(--fs-caption)] font-medium">{selected.length}</span>
            )}
          </button>
          <button
            type="button"
            onClick={closeModal}
            aria-label="閉じる"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-full)] text-[var(--color-text-muted)]"
          >
            <CloseIcon />
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
      <div className="flex-1 overflow-y-auto px-4 pt-4 pb-8 sm:px-6">
        <div className="mx-auto w-full max-w-[var(--layout-list-max)]">
          {searchError && searching && results === null ? (
            <p className="text-[length:var(--fs-caption)] text-[var(--color-text-muted)]">
              検索に失敗しました
            </p>
          ) : listLoading && articleList.length === 0 ? (
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
              {showPagination && (
                <Pagination currentPage={page} totalPages={totalPages} baseHref={baseHref} />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
