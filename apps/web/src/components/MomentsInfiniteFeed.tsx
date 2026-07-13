'use client';

import { useCallback, useState } from 'react';
import { getMoments, type MomentSummary } from '@/lib/api';
import { MomentFeed } from './MomentFeed';

interface MomentsInfiniteFeedProps {
  userName: string;
  /** サーバーで取得した 1 ページ目 */
  initialMoments: MomentSummary[];
  initialCursor: string | null;
}

/** MomentFeed の無限スクロール状態（累積リスト + カーソル）を持つクライアント側の親 */
export function MomentsInfiniteFeed({
  userName,
  initialMoments,
  initialCursor,
}: MomentsInfiniteFeedProps) {
  const [moments, setMoments] = useState(initialMoments);
  const [nextCursor, setNextCursor] = useState(initialCursor);
  const [loading, setLoading] = useState(false);

  const loadMore = useCallback(() => {
    if (nextCursor === null || loading) return;
    setLoading(true);
    getMoments(userName, { cursor: nextCursor, noCache: true })
      .then((page) => {
        setMoments((prev) => [...prev, ...page.moments]);
        setNextCursor(page.nextCursor);
      })
      .catch(() => {
        // 追加読み込みの失敗はフィードを静かに打ち切る
        // （番兵を残すと IntersectionObserver の再購読で失敗リクエストが連打されるため）
        setNextCursor(null);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [userName, nextCursor, loading]);

  return (
    <MomentFeed
      moments={moments}
      hasMore={nextCursor !== null}
      loading={loading}
      onLoadMore={loadMore}
    />
  );
}
