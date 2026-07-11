'use client';

import { ActiveTagBar } from '@/components/ActiveTagBar';
import { useTagFilter } from '@/components/TagFilterProvider';

/** 一覧上部に置く選択中タグバーのアイランド。タグの選択は FloatingTagFilter が担う */
export function TagFilterControls() {
  const { selected, mode, totalCount, toggleTag, clear } = useTagFilter();

  return (
    <ActiveTagBar
      selected={selected}
      mode={mode}
      hitCount={totalCount}
      onRemoveTag={toggleTag}
      onClear={clear}
    />
  );
}
