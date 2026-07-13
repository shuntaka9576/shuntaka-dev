'use client';

import Image from 'next/image';
import { useEffect, useRef } from 'react';
import type { MomentSummary } from '@/lib/api';
import { MomentCard } from './MomentCard';

interface MomentFeedProps {
  moments: MomentSummary[];
  /** まだ読み込める moment が残っているか。false で末尾マーカー（ochaIcon）を表示 */
  hasMore: boolean;
  /** 追加読み込み中か（スケルトンの表示制御） */
  loading: boolean;
  /** 末尾の番兵が可視域に近づいたときに呼ばれる */
  onLoadMore: () => void;
}

function MomentCardSkeleton({ tilt }: { tilt: 'left' | 'right' }) {
  return (
    <div
      className="flex animate-pulse items-center gap-7 py-7 max-sm:gap-4 max-sm:py-5"
      aria-hidden="true"
    >
      <div className={`moment-photo shrink-0 ${tilt === 'right' ? 'moment-photo--right' : ''}`}>
        <div className="rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-1.5 pb-0">
          <div className="aspect-square w-40 bg-[var(--color-border-subtle)] max-sm:w-28" />
          <div className="flex justify-center py-1.5">
            <div className="h-3 w-16 rounded-[var(--radius-sm)] bg-[var(--color-border-subtle)]" />
          </div>
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-3 h-4 w-full rounded-[var(--radius-sm)] bg-[var(--color-border-subtle)]" />
        <div className="h-4 w-2/3 rounded-[var(--radius-sm)] bg-[var(--color-border-subtle)]" />
      </div>
    </div>
  );
}

export function MomentFeed({ moments, hasMore, loading, onLoadMore }: MomentFeedProps) {
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore || loading) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          onLoadMore();
        }
      },
      // 番兵が見える少し手前で先読みして、スクロールの途切れを感じさせない
      { rootMargin: '200px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loading, onLoadMore]);

  return (
    <section role="feed" aria-busy={loading}>
      {moments.map((moment, index) => (
        <MomentCard
          key={moment.momentId}
          moment={moment}
          tilt={index % 2 === 0 ? 'left' : 'right'}
        />
      ))}
      {loading && (
        <>
          <MomentCardSkeleton tilt={moments.length % 2 === 0 ? 'left' : 'right'} />
          <MomentCardSkeleton tilt={moments.length % 2 === 0 ? 'right' : 'left'} />
        </>
      )}
      {hasMore ? (
        <div ref={sentinelRef} className="h-px" />
      ) : (
        <div className="flex justify-center py-8">
          <Image src="/assets/ochaIcon.svg" alt="" width={22} height={22} />
        </div>
      )}
    </section>
  );
}
