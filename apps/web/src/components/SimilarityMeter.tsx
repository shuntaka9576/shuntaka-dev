import { distanceToSimilarity } from '@/lib/searchQuery';

export interface SimilarityMeterProps {
  /** cosine distance (0..2)。API の distance をそのまま渡す */
  distance: number;
  /** 表示用の追加クラス（幅などレイアウト調整用） */
  className?: string;
}

/**
 * 検索結果 1 件あたりの「意味的な近さ」をパーセント + 単色バーで見せる小さな計器。
 * distance=0 で 100%、distance=2 で 0%。バーの色はアクセントカラー 1 色のみ。
 */
export function SimilarityMeter({ distance, className = '' }: SimilarityMeterProps) {
  const similarity = distanceToSimilarity(distance);
  const percent = Math.round(similarity * 100);

  return (
    <div
      className={`inline-flex shrink-0 items-center gap-1.5 text-[length:var(--fs-caption)] text-[var(--color-text-muted)] ${className}`}
      role="img"
      aria-label={`類似度 ${percent} パーセント`}
    >
      <span className="tabular-nums">{percent}%</span>
      <span
        className="relative inline-block h-1 w-12 overflow-hidden rounded-[var(--radius-full)] bg-[var(--color-border-subtle)]"
        aria-hidden="true"
      >
        <span
          className="absolute inset-y-0 left-0 rounded-[var(--radius-full)] bg-[var(--color-accent)]"
          style={{ width: `${percent}%` }}
        />
      </span>
    </div>
  );
}
