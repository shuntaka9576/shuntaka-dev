'use client';

import { Fragment } from 'react';
import type { TagFilterMode } from '@/lib/tagFilter';

interface ActiveTagBarProps {
  selected: string[];
  mode: TagFilterMode;
  hitCount: number;
  onRemoveTag: (path: string) => void;
  onClear: () => void;
  /** アクティブな検索クエリ。空文字なら未表示 */
  searchQuery?: string;
  /** 検索クエリチップ × 押下時のハンドラ */
  onRemoveSearchQuery?: () => void;
}

/**
 * パネルを閉じても選択状態が見えるよう、一覧上部に選択チップとヒット件数を表示する。
 * 検索クエリが指定されているときは、タグチップの前に `search: "..."` の削除可能チップを並べる。
 */
export function ActiveTagBar({
  selected,
  mode,
  hitCount,
  onRemoveTag,
  onClear,
  searchQuery,
  onRemoveSearchQuery,
}: ActiveTagBarProps) {
  const hasSearch = Boolean(searchQuery);
  if (!hasSearch && selected.length === 0) return null;

  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-[length:var(--fs-caption)]">
      {hasSearch && onRemoveSearchQuery && (
        <>
          <button
            type="button"
            onClick={onRemoveSearchQuery}
            aria-label={`検索クエリ ${searchQuery} を解除`}
            className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--color-text)] px-2 py-0.5 text-[var(--color-text)]"
          >
            <span aria-hidden="true">search:</span>「{searchQuery}」
            <span aria-hidden="true">×</span>
          </button>
          {selected.length > 0 && (
            <span className="text-[var(--color-text-muted)]" aria-hidden="true">
              AND
            </span>
          )}
        </>
      )}
      {selected.map((tag, i) => (
        <Fragment key={tag}>
          {i > 0 && (
            <span className="text-[var(--color-text-muted)]" aria-hidden="true">
              {mode === 'and' ? 'AND' : 'OR'}
            </span>
          )}
          <button
            type="button"
            onClick={() => onRemoveTag(tag)}
            aria-label={`${tag} の絞り込みを解除`}
            className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--color-text)] px-2 py-0.5 text-[var(--color-text)]"
          >
            #{tag}
            <span aria-hidden="true">×</span>
          </button>
        </Fragment>
      ))}
      <span className="text-[var(--color-text-muted)]">{hitCount}件</span>
      <button type="button" onClick={onClear} className="text-[var(--color-text-muted)] underline">
        クリア
      </button>
    </div>
  );
}
