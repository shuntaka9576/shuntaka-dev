'use client';

import { useEffect } from 'react';
import { TagCloud } from '@/components/TagCloud';
import { useTagFilter } from '@/components/TagFilterProvider';

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
 * タグ絞り込み専用のボトムシート。SearchModal の下側に重ねて出すため、
 * 検索窓・選択タグ chips は隠さない (SearchModal の上バーはそのまま見える)。
 *
 * ここは 「タグをぽちぽち押しながらフィルタが即座に反映される」インタラクションを担う。
 * 選択タグ chips / AND OR / クリアは SearchModal 側のヘッダに常時出ているのでここには置かない。
 */
export function TagFilterModal() {
  const { tagModalOpen, selected, tagTree, facetsError, toggleTag, closeTagModal } = useTagFilter();

  useEffect(() => {
    if (!tagModalOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeTagModal();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [tagModalOpen, closeTagModal]);

  if (!tagModalOpen) return null;

  return (
    <>
      {/* 背景クリックで閉じる。SearchModal の上バーは覆わず、body 領域だけ暗くする想定はせず透明にする */}
      <button
        type="button"
        aria-label="タグモーダルを閉じる"
        onClick={closeTagModal}
        className="fixed inset-0 z-[55] cursor-default bg-transparent"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="タグで絞り込む"
        className="fixed inset-x-0 bottom-0 z-[60] flex max-h-[70vh] flex-col rounded-t-[var(--radius-lg)] border-t border-[var(--color-border)] bg-[var(--color-surface-raised)] shadow-[var(--shadow-3)]"
      >
        <button
          type="button"
          onClick={closeTagModal}
          aria-label="閉じる"
          className="absolute top-2 right-2 z-10 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-full)] text-[var(--color-text-muted)]"
        >
          <CloseIcon />
        </button>

        <div className="flex-1 overflow-y-auto px-4 pt-3 pb-6 sm:px-6">
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
    </>
  );
}
