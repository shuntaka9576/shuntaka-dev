'use client';

import { Fragment } from 'react';
import { TagCloud } from '@/components/TagCloud';
import { useTagFilter } from '@/components/TagFilterProvider';
import { useFullScreenModal } from '@/lib/useFullScreenModal';

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
 * タグ絞り込み専用の全画面モーダル。TagFilterProvider の `tagModalOpen` を "modal 開閉" 状態として使う。
 *
 * 構成:
 *   - Header: 選択タグ chips + AND/OR + クリア + × close
 *   - Body: TagCloud (uppercase セクション見出し + pill、件数降順)
 *
 * タグ tap で即座にトグル・URL 同期・記事一覧の再フェッチが走る (TagFilterProvider 経由)。
 * 別モーダルで開いていても背後の記事一覧は URL 状態を通じて追随する。
 */
export function TagFilterModal() {
  const {
    tagModalOpen,
    selected,
    mode,
    filtering,
    tagTree,
    facetsError,
    toggleTag,
    changeMode,
    clear: clearTags,
    closeTagModal,
  } = useTagFilter();

  const { containerStyle } = useFullScreenModal(tagModalOpen, closeTagModal);

  if (!tagModalOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="タグで絞り込む"
      className="fixed inset-x-0 z-50 flex flex-col bg-[var(--color-bg)]"
      style={containerStyle}
    >
      {/* Header: close + selected chips */}
      <div className="shrink-0 border-b border-[var(--color-border-subtle)] px-4 pt-3 pb-3 sm:px-6">
        <div className="mx-auto flex w-full max-w-[calc(var(--layout-list-max)+4rem)] items-center justify-between gap-2">
          <span className="text-[length:var(--fs-caption)] text-[var(--color-text-muted)]">
            タグで絞り込む
          </span>
          <button
            type="button"
            onClick={closeTagModal}
            aria-label="閉じる"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-full)] text-[var(--color-text-muted)]"
          >
            <CloseIcon />
          </button>
        </div>

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
            {filtering && (
              <button
                type="button"
                onClick={clearTags}
                className="text-[var(--color-text-muted)] underline"
              >
                クリア
              </button>
            )}
          </div>
        )}
      </div>

      {/* Body: TagCloud */}
      <div className="flex-1 overflow-y-auto px-4 pt-4 pb-8 sm:px-6">
        <div className="mx-auto w-full max-w-[var(--layout-list-max)]">
          <TagCloud nodes={tagTree} selected={selected} onToggleTag={toggleTag} />
          {facetsError && (
            <p className="mt-4 text-[length:var(--fs-caption)] text-[var(--color-text-muted)]">
              タグ件数を更新できませんでした
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
