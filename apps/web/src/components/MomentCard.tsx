import Image from 'next/image';
import { memo } from 'react';
import type { MomentSummary } from '@/lib/api';

interface MomentCardProps {
  moment: MomentSummary;
  /** 写真の傾き方向。一覧では index の偶奇で交互に渡してスクラップブック感を出す */
  tilt?: 'left' | 'right';
}

function formatDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

/** 木製クリップ（洗濯バサミ）。縦長の直線シルエット + 明るい松系の木肌 + 中央の金属バネ */
function ClothespinIcon() {
  return (
    <svg
      className="moment-fastener moment-clip"
      width="18"
      height="40"
      viewBox="0 0 18 40"
      aria-hidden="true"
    >
      {/* 写真への落ち影 */}
      <ellipse cx="9" cy="38.8" rx="5.5" ry="1.1" fill="rgba(0, 0, 0, 0.12)" />
      {/* 本体（縦長の板。バネが巻く位置で両サイドが浅くくびれる） */}
      <path
        d="M4.8 0.8 L13.2 0.8 Q14.8 0.8 14.8 2.4 L14.8 15.3 Q13.9 15.8 13.9 16.9 Q13.9 18 14.8 18.5 L14.8 37.3 Q14.8 38.3 13.8 38.3 L4.2 38.3 Q3.2 38.3 3.2 37.3 L3.2 18.5 Q4.1 18 4.1 16.9 Q4.1 15.8 3.2 15.3 L3.2 2.4 Q3.2 0.8 4.8 0.8 Z"
        fill="#d9ba88"
      />
      {/* 上端の木口（端面はやや明るい） */}
      <path
        d="M4.8 0.8 L13.2 0.8 Q14.8 0.8 14.8 2.4 L14.8 3.6 L3.2 3.6 L3.2 2.4 Q3.2 0.8 4.8 0.8 Z"
        fill="#e9d4a4"
      />
      {/* 右側の陰影（丸みの表現） */}
      <path
        d="M11.8 0.8 L13.2 0.8 Q14.8 0.8 14.8 2.4 L14.8 15.3 Q13.9 15.8 13.9 16.9 Q13.9 18 14.8 18.5 L14.8 37.3 Q14.8 38.3 13.8 38.3 L11.8 38.3 Z"
        fill="#a8834f"
        opacity="0.32"
      />
      {/* 左端のハイライト */}
      <rect x="4.4" y="2" width="1.1" height="35.4" fill="#f2e2b8" opacity="0.5" />
      {/* 木目 */}
      <path d="M7.5 4.5 L7.2 36.5" stroke="#b18d5a" strokeWidth="0.5" opacity="0.5" fill="none" />
      <path d="M10.4 5.5 L10.8 35" stroke="#b18d5a" strokeWidth="0.5" opacity="0.3" fill="none" />
      {/* 金属バネ: くびれを巻くワイヤ + 右側に垂れる押さえのループ */}
      <rect x="4.2" y="17.9" width="9.6" height="0.6" fill="#8a6a40" opacity="0.4" />
      <rect x="2.4" y="16.3" width="13.2" height="1.3" rx="0.65" fill="#9aa1aa" />
      <rect x="2.4" y="16.3" width="13.2" height="0.55" rx="0.28" fill="#c8cdd3" />
      <path
        d="M15.2 17 C 17.4 17.8 17.2 21.4 14.8 22 L13.6 22.2"
        stroke="#9aa1aa"
        strokeWidth="1.1"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}

export const MomentCard = memo(function MomentCard({ moment, tilt = 'left' }: MomentCardProps) {
  const fastener = moment.fastener ?? 'clip';
  const colorClass = moment.fastenerColor ? ` moment-tape--${moment.fastenerColor}` : '';

  return (
    <article className="moment-card group flex items-center gap-7 py-7 max-sm:gap-4 max-sm:py-5">
      <div className={`moment-photo shrink-0 ${tilt === 'right' ? 'moment-photo--right' : ''}`}>
        {/* 留め具（clip = 木製クリップ / tape = マスキングテープ）。実物っぽさ優先で描画 */}
        {fastener === 'clip' ? (
          <ClothespinIcon />
        ) : (
          <div className={`moment-fastener moment-tape${colorClass}`} aria-hidden="true" />
        )}
        <figure className="rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-1.5 pb-0 transition-shadow duration-[var(--motion-base)] group-hover:shadow-[var(--shadow-2)]">
          {/* 表示は 160px 四方のため一覧は thumb（長辺 640px）で足りる */}
          <Image
            src={moment.thumbUrl}
            alt={moment.text}
            width={480}
            height={480}
            className="aspect-square w-40 object-cover max-sm:w-28"
            loading="lazy"
          />
          <figcaption className="py-1.5 text-center text-xs text-[var(--color-text-muted)]">
            {formatDate(moment.publishedAt)}
          </figcaption>
        </figure>
      </div>
      <p className="min-w-0 flex-1 text-base leading-[var(--lh-body)]">{moment.text}</p>
    </article>
  );
});
