'use client';

import { ArticleCard } from '@/components/ArticleCard';
import { useTagFilter } from '@/components/TagFilterProvider';

interface FilteredArticleListProps {
  userName: string;
  /** サーバーレンダリング済みの既定一覧（ページスライス + ページネーション） */
  children: React.ReactNode;
}

/**
 * 絞り込みなしのときはサーバーレンダリング済みの children をそのまま表示し、
 * 絞り込み中だけクライアント側でヒット記事に差し替える
 */
export function FilteredArticleList({ userName, children }: FilteredArticleListProps) {
  const { filtering, matched, mode, changeMode, clear, isTagMatched } = useTagFilter();

  if (!filtering) return children;

  if (matched.length === 0) {
    return (
      <div>
        <p>一致する記事がありません。</p>
        <div className="mt-2 flex gap-3 text-[length:var(--fs-caption)]">
          {mode === 'and' && (
            <button
              type="button"
              onClick={() => changeMode('or')}
              className="text-[var(--color-text-muted)] underline"
            >
              OR に切り替える
            </button>
          )}
          <button
            type="button"
            onClick={clear}
            className="text-[var(--color-text-muted)] underline"
          >
            タグを外す
          </button>
        </div>
      </div>
    );
  }

  const priorityArticleIds = new Set(
    matched
      .map((e) => e.article)
      .filter((a) => a.thumbnail)
      .slice(0, 2)
      .map((a) => a.articleId),
  );

  return matched.map(({ article, relativeTags }) => (
    <ArticleCard
      key={article.articleId}
      article={article}
      userName={userName}
      priority={priorityArticleIds.has(article.articleId)}
      tags={relativeTags.map((path) => ({ path, matched: isTagMatched(path) }))}
    />
  ));
}
