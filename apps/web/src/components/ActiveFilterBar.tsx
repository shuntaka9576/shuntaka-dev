'use client';

import { ActiveTagBar } from '@/components/ActiveTagBar';
import { useSearch } from '@/components/SearchProvider';
import { useTagFilter } from '@/components/TagFilterProvider';

/**
 * トップ (記事一覧) 上部に「今何で絞り込んでいるか」を表示するアイランド。
 * 検索クエリ + 選択タグ chip を並べ、× で個別解除 / クリアで一括解除できる。
 * どちらも 0 件のときは何も描画しない (`ActiveTagBar` が null を返す)。
 */
export function ActiveFilterBar() {
  const { selected, mode, totalCount, toggleTag, clear: clearTags } = useTagFilter();
  const { submittedQuery, results, clearQuery } = useSearch();

  const searching = submittedQuery.length > 0;
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
