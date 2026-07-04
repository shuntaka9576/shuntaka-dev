'use client';

import { TagFilterToggle } from '@/components/TagFilterToggle';
import { TAG_FILTER_PANEL_ID, useTagFilter } from '@/components/TagFilterProvider';

/** タブ行右端に置く「tags」トグルのアイランド。状態は TagFilterProvider が持つ */
export function TagFilterHeaderToggle() {
  const { panelOpen, filtering, togglePanel } = useTagFilter();
  return (
    <TagFilterToggle
      open={panelOpen}
      active={filtering}
      onClick={togglePanel}
      panelId={TAG_FILTER_PANEL_ID}
    />
  );
}
