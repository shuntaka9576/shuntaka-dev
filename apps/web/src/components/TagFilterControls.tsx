'use client';

import { ActiveTagBar } from '@/components/ActiveTagBar';
import { TagFilterPanel } from '@/components/TagFilterPanel';
import { TAG_FILTER_PANEL_ID, useTagFilter } from '@/components/TagFilterProvider';

/** 一覧上部に置くタグパネル + 選択中バーのアイランド */
export function TagFilterControls() {
  const { panelOpen, selected, mode, totalCount, tagTree, facetsError, toggleTag, changeMode, clear } =
    useTagFilter();

  return (
    <>
      {panelOpen && (
        <>
          <TagFilterPanel
            id={TAG_FILTER_PANEL_ID}
            nodes={tagTree}
            selected={selected}
            mode={mode}
            onToggleTag={toggleTag}
            onModeChange={changeMode}
          />
          {facetsError && (
            <p className="mb-2 text-[length:var(--fs-caption)] text-[var(--color-text-muted)]">
              タグ件数を更新できませんでした
            </p>
          )}
        </>
      )}
      <ActiveTagBar
        selected={selected}
        mode={mode}
        hitCount={totalCount}
        onRemoveTag={toggleTag}
        onClear={clear}
      />
    </>
  );
}
