'use client';

import { Fragment, useEffect, useRef } from 'react';
import { ProgressLink } from '@/components/ProgressLink';
import { useSearch } from '@/components/SearchProvider';
import { SearchInput } from '@/components/SearchInput';
import { SimilarityMeter } from '@/components/SimilarityMeter';
import { TAG_FILTER_PANEL_ID, useTagFilter } from '@/components/TagFilterProvider';
import { TagFilterTree } from '@/components/TagFilterTree';

/** パネルを閉じるまでに許容するページスクロール量 (px)。絞り込みによるレイアウトシフト分を吸収する */
const SCROLL_CLOSE_THRESHOLD = 30;

/** プレビューに出す上位件数（doc 5-3 のパネル ASCII に合わせる） */
const PREVIEW_LIMIT = 3;

interface FloatingSearchTagFilterProps {
  userName: string;
}

/** Lucide "search" 相当（stroke 1.5px、塗りなし） */
function SearchIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

/** Lucide "tag" 相当（既存 FloatingTagFilter と同じマーク） */
function TagIcon() {
  return (
    <svg
      width="18"
      height="18"
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

/**
 * 画面下部中央に固定表示するフローティング絞り込み UI。
 *
 * ピルは 1 個 (`[🔍  🏷 N]`) で、押すとパネルが上に展開する。パネルは 1 面構成で
 * 上から順に `SearchInput` / 選択タグの chip / 検索プレビュー / タグツリー を縦に並べる。
 * タブや mode 切替はせず、意味検索とタグ絞り込みが同時に見える構造にすることで
 * 「両方を組み合わせて使える」を明示する。
 *
 * 開いている間はページスクロール・パネル外タップ・Escape で閉じる。
 * 検索 input が非空のとき Escape はまず input を clear するため、パネル閉じは 2 回目の Escape で発火する。
 */
export function FloatingSearchTagFilter({ userName }: FloatingSearchTagFilterProps) {
  const {
    panelOpen,
    selected,
    mode,
    filtering,
    totalCount,
    fetchedArticles,
    tagTree,
    facetsError,
    togglePanel,
    closePanel,
    toggleTag,
    changeMode,
    clear: clearTags,
  } = useTagFilter();

  const {
    query,
    submittedQuery,
    searching,
    results,
    loading,
    error,
    setQuery,
    submitNow,
    clearQuery,
    retry,
  } = useSearch();

  const containerRef = useRef<HTMLDivElement>(null);
  const scrollBaseline = useRef(0);

  // パネルを開いた時点と絞り込み結果の再描画時に基準位置を取り直す。
  // タグ選択で一覧の高さが変わるとブラウザが scrollY を丸めることがあり、
  // 基準を据え置くとその移動だけで閾値を超えてしまうため
  useEffect(() => {
    scrollBaseline.current = window.scrollY;
  }, [panelOpen, fetchedArticles, results]);

  useEffect(() => {
    if (!panelOpen) return;

    const onScroll = () => {
      if (Math.abs(window.scrollY - scrollBaseline.current) > SCROLL_CLOSE_THRESHOLD) {
        closePanel();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) closePanel();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closePanel();
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('scroll', onScroll);
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [panelOpen, closePanel]);

  const active = filtering || searching;
  const preview = results?.slice(0, PREVIEW_LIMIT) ?? [];
  const overflow = (results?.length ?? 0) - preview.length;
  const showDivider = filtering || searching;

  return (
    <div
      ref={containerRef}
      className="fixed bottom-[calc(var(--space-5)+env(safe-area-inset-bottom))] left-1/2 z-20 flex w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 flex-col items-center"
    >
      {panelOpen && (
        <div
          id={TAG_FILTER_PANEL_ID}
          className="mb-2 flex max-h-[65vh] w-full flex-col gap-3 overflow-y-auto rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3 shadow-[var(--shadow-3)]"
        >
          {/* 検索入力（常に一番上） */}
          <SearchInput
            value={query}
            onChange={setQuery}
            onClear={clearQuery}
            onSubmit={submitNow}
            loading={loading}
          />

          {/* 併用状態のヒント: 選択タグを chip で見せる（tagツリーで再操作可能） */}
          {selected.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[length:var(--fs-caption)]">
              <span className="text-[var(--color-text-muted)]">タグ:</span>
              {selected.map((tag, i) => (
                <Fragment key={tag}>
                  {i > 0 && (
                    <span className="text-[var(--color-text-muted)]" aria-hidden="true">
                      {mode === 'and' ? 'AND' : 'OR'}
                    </span>
                  )}
                  <span className="inline-flex items-center rounded-[var(--radius-sm)] border border-[var(--color-text)] px-2 py-0.5 text-[var(--color-text)]">
                    #{tag}
                  </span>
                </Fragment>
              ))}
            </div>
          )}

          {/* 検索プレビュー（検索中だけ） */}
          {searching && (
            <div className="border-t border-[var(--color-border-subtle)] pt-3">
              {loading && results === null && (
                <p
                  className="text-[length:var(--fs-caption)] text-[var(--color-text-muted)]"
                  aria-live="polite"
                >
                  読み込み中…
                </p>
              )}
              {error && results === null && (
                <div className="text-[length:var(--fs-caption)]">
                  <p className="text-[var(--color-text-muted)]">検索に失敗しました。</p>
                  <div className="mt-2 flex gap-3">
                    <button
                      type="button"
                      onClick={retry}
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
              )}
              {results !== null && results.length === 0 && !loading && (
                <div className="text-[length:var(--fs-caption)]">
                  <p>「{submittedQuery}」に一致する記事はありません。</p>
                  <button
                    type="button"
                    onClick={clearQuery}
                    className="mt-2 text-[var(--color-text-muted)] underline"
                  >
                    検索を解除
                  </button>
                </div>
              )}
              {preview.length > 0 && (
                <>
                  <ul className="flex flex-col gap-2">
                    {preview.map((article) => (
                      <li key={article.articleId}>
                        <ProgressLink href={`/${userName}/articles/${article.slug}`}>
                          <div
                            className="flex items-center justify-between gap-3"
                            onClickCapture={closePanel}
                          >
                            <span className="line-clamp-1 flex-1 text-[length:var(--fs-caption)] text-[var(--color-text)]">
                              {article.title}
                            </span>
                            <SimilarityMeter distance={article.distance} />
                          </div>
                        </ProgressLink>
                      </li>
                    ))}
                  </ul>
                  {overflow > 0 && (
                    <button
                      type="button"
                      onClick={closePanel}
                      className="mt-3 block w-full text-center text-[length:var(--fs-caption)] text-[var(--color-text-muted)] underline"
                    >
                      全 {results?.length ?? 0} 件を一覧で見る →
                    </button>
                  )}
                </>
              )}
            </div>
          )}

          {/* タグツリー (常に表示。上部の情報とスクロール一体) */}
          <div className={showDivider ? 'border-t border-[var(--color-border-subtle)] pt-3' : ''}>
            <TagFilterTree nodes={tagTree} selected={selected} onToggleTag={toggleTag} />
            {facetsError && (
              <p className="mt-2 text-[length:var(--fs-caption)] text-[var(--color-text-muted)]">
                タグ件数を更新できませんでした
              </p>
            )}
          </div>

          {selected.length >= 2 && (
            <div className="flex items-center gap-2 border-t border-[var(--color-border-subtle)] pt-3 text-[length:var(--fs-caption)]">
              <div
                role="group"
                aria-label="タグの絞り込み条件"
                className="inline-flex divide-x divide-[var(--color-border)] overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-border)]"
              >
                <button
                  type="button"
                  aria-pressed={mode === 'and'}
                  onClick={() => changeMode('and')}
                  className={`px-2 py-0.5 ${
                    mode === 'and'
                      ? 'font-medium text-[var(--color-text)]'
                      : 'text-[var(--color-text-muted)]'
                  }`}
                >
                  AND
                </button>
                <button
                  type="button"
                  aria-pressed={mode === 'or'}
                  onClick={() => changeMode('or')}
                  className={`px-2 py-0.5 ${
                    mode === 'or'
                      ? 'font-medium text-[var(--color-text)]'
                      : 'text-[var(--color-text-muted)]'
                  }`}
                >
                  OR
                </button>
              </div>
              <span className="text-[var(--color-text-muted)]">
                {mode === 'and' ? 'すべてのタグを含む記事' : 'いずれかのタグを含む記事'}
              </span>
            </div>
          )}

          {filtering && (
            <div className="flex items-center gap-2 text-[length:var(--fs-caption)]">
              <span className="text-[var(--color-text-muted)]">{totalCount}件</span>
              <button
                type="button"
                onClick={clearTags}
                className="text-[var(--color-text-muted)] underline"
              >
                タグをクリア
              </button>
            </div>
          )}
        </div>
      )}

      {/* 単一ピル: 検索とタグを 1 単位として表示（分割線は入れない） */}
      <button
        type="button"
        onClick={togglePanel}
        aria-expanded={panelOpen}
        aria-controls={TAG_FILTER_PANEL_ID}
        aria-label="検索とタグで絞り込む"
        className={`inline-flex items-center gap-2 rounded-[var(--radius-full)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-4 py-3 shadow-[var(--shadow-2)] ${
          active ? 'text-[var(--color-text)]' : 'text-[var(--color-text-muted)]'
        }`}
      >
        <SearchIcon />
        <TagIcon />
        {filtering && (
          <span className="text-[length:var(--fs-caption)] font-medium">{selected.length}</span>
        )}
      </button>
    </div>
  );
}
