/**
 * ArticleCard の形をなぞる skeleton loader。
 * 初回検索・初回タグ絞り込みの結果待ちの間に表示し、
 * "読み込み中…" のプレーンテキストより「これから記事一覧が入る」ことを直感的に伝える。
 *
 * 実 ArticleCard と同じ高さ (title 行 + date 行 + サムネ) を確保して、
 * データ到着時のレイアウトシフトを最小化する。
 */
export function ArticleCardSkeleton({ withThumbnail = true }: { withThumbnail?: boolean }) {
  return (
    <div
      aria-hidden="true"
      className="mb-4 block w-full border-b border-[var(--color-border-subtle)]"
    >
      <div className="mb-2 flex animate-pulse justify-between">
        <div className="min-w-0 flex-1">
          {/* Title placeholder (2 行想定): base * 2 = 32px + 余白 */}
          <div className="pt-2 pr-2 pb-4">
            <div className="mb-2 h-4 w-11/12 rounded-[var(--radius-sm)] bg-[var(--color-border-subtle)]" />
            <div className="h-4 w-3/5 rounded-[var(--radius-sm)] bg-[var(--color-border-subtle)]" />
          </div>
          {/* Date placeholder: caption サイズ */}
          <div className="h-3 w-20 rounded-[var(--radius-sm)] bg-[var(--color-border-subtle)]" />
        </div>
        {withThumbnail && (
          <div className="ml-4 shrink-0">
            <div className="h-[100px] w-[150px] rounded-[var(--radius-md)] bg-[var(--color-border-subtle)]" />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * ArticleCardSkeleton を n 件並べる。デフォルト 5 件で、1 画面分の
 * "これから記事が並ぶ" プレビューになる。
 */
export function ArticleCardSkeletonList({ count = 5 }: { count?: number }) {
  return (
    <div>
      {Array.from({ length: count }, (_, i) => (
        <ArticleCardSkeleton key={i} withThumbnail={i % 2 === 0} />
      ))}
    </div>
  );
}
