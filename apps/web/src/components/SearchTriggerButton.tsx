'use client';

import { useSearch } from '@/components/SearchProvider';
import { useTagFilter } from '@/components/TagFilterProvider';

/** Lucide "search" 相当 */
function SearchIcon() {
  return (
    <svg
      width="24"
      height="24"
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
 * コンテンツカラムの右下に固定表示する SearchModal のトリガー。
 * コンテンツ幅と同じ max-width + padding のラッパーで右端を揃える。
 */
export function SearchTriggerButton() {
  const { openModal, searching, modalOpen } = useSearch();
  const { filtering } = useTagFilter();
  const active = searching || filtering;

  if (modalOpen) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-40">
      <div className="mx-auto max-w-[calc(var(--layout-list-max)+4rem)] px-8 max-sm:px-4">
        <div className="flex justify-end">
          <button
            type="button"
            onClick={openModal}
            aria-label="検索とタグで絞り込む"
            className={`pointer-events-auto relative inline-flex h-14 w-14 items-center justify-center rounded-[var(--radius-full)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] shadow-[var(--shadow-2)] ${
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
      </div>
    </div>
  );
}
