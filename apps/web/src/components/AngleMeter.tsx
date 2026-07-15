import { distanceToAngle } from '@/lib/searchQuery';

export interface AngleMeterProps {
  /** cosine distance (0..2)。API の distance をそのまま渡す */
  distance: number;
  /** 表示用の追加クラス（レイアウト調整用） */
  className?: string;
}

// 半円分度器のジオメトリ（SVG 座標。上半分だけを使う）
const CX = 22;
const CY = 22;
const R = 18;

/** 角度（度, 0=右水平 / 90=真上 / 180=左水平）を SVG 座標に変換する */
function polar(angleDeg: number, radius: number = R): { x: number; y: number } {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: CX + radius * Math.cos(rad), y: CY - radius * Math.sin(rad) };
}

/** 右水平 (0°) から angleDeg までの円弧 path を返す */
function arcPath(angleDeg: number): string {
  const start = polar(0);
  const end = polar(angleDeg);
  const largeArc = angleDeg > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${R} ${R} 0 ${largeArc} 0 ${end.x} ${end.y}`;
}

/**
 * 検索結果 1 件あたりの「クエリと記事ベクトルのなす角」を、半円分度器 + 針で見せる計器。
 * distance=0 で 0°(激似)、distance=2 で 180°(正反対)。針・トレイル・中心点のみアクセント 1 色。
 */
export function AngleMeter({ distance, className = '' }: AngleMeterProps) {
  const angle = distanceToAngle(distance);
  const deg = Math.round(angle);
  const needle = polar(angle);
  const background = arcPath(180);
  const trail = arcPath(angle);

  return (
    <div
      className={`inline-flex shrink-0 items-center gap-1.5 text-[length:var(--fs-caption)] text-[var(--color-text-muted)] ${className}`}
      role="img"
      aria-label={`クエリと記事ベクトルのなす角 ${deg} 度`}
    >
      <svg width="30" height="17" viewBox="0 0 44 24" fill="none" aria-hidden="true">
        {/* 分度器の弧 */}
        <path
          d={background}
          stroke="var(--color-border-subtle)"
          strokeWidth="2"
          strokeLinecap="round"
        />
        {/* 45° 刻みの目盛り */}
        {[45, 90, 135].map((tick) => {
          const outer = polar(tick);
          const inner = polar(tick, R - 3);
          return (
            <line
              key={tick}
              x1={inner.x}
              y1={inner.y}
              x2={outer.x}
              y2={outer.y}
              stroke="var(--color-border)"
              strokeWidth="1"
            />
          );
        })}
        {/* 0° → θ のトレイル */}
        <path d={trail} stroke="var(--color-accent)" strokeWidth="2.5" strokeLinecap="round" />
        {/* 針 */}
        <line
          x1={CX}
          y1={CY}
          x2={needle.x}
          y2={needle.y}
          stroke="var(--color-accent)"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <circle cx={CX} cy={CY} r="2" fill="var(--color-accent)" />
      </svg>
      <span className="tabular-nums">θ {deg}°</span>
    </div>
  );
}
