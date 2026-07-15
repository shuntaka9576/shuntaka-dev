'use client';

import { ActiveTagBar } from '@/components/ActiveTagBar';
import { useSearch } from '@/components/SearchProvider';
import { useTagFilter } from '@/components/TagFilterProvider';

/**
 * 一覧上部に置く選択状態バーのアイランド。タグの選択は FloatingSearchTagFilter が担う。
 * 検索クエリ or タグどちらかが有効なとき ActiveTagBar が表示される。
 */
export function TagFilterControls() {
  const { selected, mode, totalCount, toggleTag, clear: clearTags } = useTagFilter();
  const { submittedQuery, results, clearQuery } = useSearch();

  const searching = submittedQuery.length > 0;
  // 検索中は検索ヒット件数を、そうでなければタグ絞り込みヒット件数を表示する
  const hitCount = searching ? (results?.length ?? 0) : totalCount;

  const clearAll = () => {
    clearTags();
    if (searching) clearQuery();
  };

  return (
    <ActiveTagBar
      selected={selected}
      mode={mode}
      hitCount={hitCount}
      onRemoveTag={toggleTag}
      onClear={clearAll}
      searchQuery={searching ? submittedQuery : undefined}
      onRemoveSearchQuery={searching ? clearQuery : undefined}
    />
  );
}
