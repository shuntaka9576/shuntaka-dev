'use client';

import { useEffect, useRef } from 'react';
import { TagFilterTree } from '@/components/TagFilterTree';
import { TAG_FILTER_PANEL_ID, useTagFilter } from '@/components/TagFilterProvider';

/** パネルを閉じるまでに許容するページスクロール量 (px)。絞り込みによるレイアウトシフト分を吸収する */
const SCROLL_CLOSE_THRESHOLD = 30;

/**
 * 画面下部中央に固定表示するタグ絞り込み UI。
 * トリガーピルをタップするとファイルツリー風のタグパネルが上に展開する。
 * 開いている間はページスクロール・パネル外タップ・Escape で閉じる。
 */
export function FloatingTagFilter() {
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
    clear,
  } = useTagFilter();

  const containerRef = useRef<HTMLDivElement>(null);
  const scrollBaseline = useRef(0);

  // パネルを開いた時点と絞り込み結果の再描画時に基準位置を取り直す。
  // タグ選択で一覧の高さが変わるとブラウザが scrollY を丸めることがあり、
  // 基準を据え置くとその移動だけで閾値を超えてしまうため
  useEffect(() => {
    scrollBaseline.current = window.scrollY;
  }, [panelOpen, fetchedArticles]);

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

  return (
    <div
      ref={containerRef}
      className="fixed bottom-[calc(var(--space-5)+env(safe-area-inset-bottom))] left-1/2 z-20 flex w-[min(20rem,calc(100vw-2rem))] -translate-x-1/2 flex-col items-center"
    >
      {panelOpen && (
        <div
          id={TAG_FILTER_PANEL_ID}
          className="mb-2 max-h-[50vh] w-full overflow-y-auto rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3 shadow-[var(--shadow-3)]"
        >
          <TagFilterTree nodes={tagTree} selected={selected} onToggleTag={toggleTag} />
          {facetsError && (
            <p className="mt-2 text-[length:var(--fs-caption)] text-[var(--color-text-muted)]">
              タグ件数を更新できませんでした
            </p>
          )}
          {selected.length >= 2 && (
            <div className="mt-3 flex items-center gap-2 border-t border-[var(--color-border-subtle)] pt-3 text-[length:var(--fs-caption)]">
              <div
                role="group"
                aria-label="絞り込み条件"
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
            <div className="mt-3 flex items-center gap-2 text-[length:var(--fs-caption)]">
              <span className="text-[var(--color-text-muted)]">{totalCount}件</span>
              <button
                type="button"
                onClick={clear}
                className="text-[var(--color-text-muted)] underline"
              >
                クリア
              </button>
            </div>
          )}
        </div>
      )}
      <button
        type="button"
        onClick={togglePanel}
        aria-expanded={panelOpen}
        aria-controls={TAG_FILTER_PANEL_ID}
        aria-label="タグで絞り込む"
        className={`inline-flex items-center gap-1 rounded-[var(--radius-full)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3 shadow-[var(--shadow-2)] ${
          panelOpen || filtering ? 'text-[var(--color-text)]' : 'text-[var(--color-text-muted)]'
        }`}
      >
        {/* タグアイコン（Lucide "tag" 相当、stroke 1.5px・塗りなし） */}
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
        {filtering && (
          <span className="text-[length:var(--fs-caption)] font-medium">{selected.length}</span>
        )}
      </button>
    </div>
  );
}
