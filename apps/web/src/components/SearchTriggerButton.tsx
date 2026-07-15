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
 * ヘッダー右側に置く SearchModal のトリガー。虫眼鏡アイコン。
 *
 * 絞り込み (検索クエリ or 選択タグ) が有効なときは、アイコン色を text 色に切替 +
 * 右上に小さなドットを付けて「フィルタ有効」を示すマーカーとして機能する。
 */
export function SearchTriggerButton() {
  const { openModal, searching } = useSearch();
  const { filtering } = useTagFilter();
  const active = searching || filtering;

  return (
    <button
      type="button"
      onClick={openModal}
      aria-label="検索とタグで絞り込む"
      className={`relative inline-flex h-8 w-8 items-center justify-center ${
        active ? 'text-[var(--color-text)]' : 'text-[var(--color-text-muted)]'
      }`}
    >
      <SearchIcon />
      {active && (
        <span
          aria-hidden="true"
          className="absolute top-1 right-1 h-1.5 w-1.5 rounded-[var(--radius-full)] bg-[var(--color-text)]"
        />
      )}
    </button>
  );
}
