'use client';

import { useSearch } from '@/components/SearchProvider';
import { useTagFilter } from '@/components/TagFilterProvider';

/** Lucide "search" 相当 */
function SearchIcon() {
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
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

/**
 * 画面下部中央に固定表示する SearchModal のトリガー。虫眼鏡アイコンの円形ボタン。
 *
 * 絞り込み (検索クエリ or 選択タグ) が有効なときは、アイコン色を text 色に切替 +
 * 右上に小さなドットを付けて「フィルタ有効」を示すマーカーとして機能する。
 */
export function SearchTriggerButton() {
  const { openModal, searching, modalOpen } = useSearch();
  const { filtering } = useTagFilter();
  const active = searching || filtering;

  if (modalOpen) return null;

  return (
    <div className="fixed bottom-6 left-1/2 z-40 -translate-x-1/2">
      <button
        type="button"
        onClick={openModal}
        aria-label="検索とタグで絞り込む"
        className={`relative inline-flex h-12 w-12 items-center justify-center rounded-[var(--radius-full)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] shadow-[var(--shadow-2)] ${
          active ? 'text-[var(--color-text)]' : 'text-[var(--color-text-muted)]'
        }`}
      >
        <SearchIcon />
        {active && (
          <span
            aria-hidden="true"
            className="absolute top-1.5 right-1.5 h-2 w-2 rounded-[var(--radius-full)] bg-[var(--color-text)]"
          />
        )}
      </button>
    </div>
  );
}
