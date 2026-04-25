import { BaseLayout } from '@/components/BaseLayout';

export default function ArticleLoading() {
  return (
    <BaseLayout>
      <div className="article-header">
        <div className="h-10 w-3/4 mx-auto animate-pulse rounded bg-[var(--color-surface)]" />
      </div>
      <div className="article-body">
        <article className="article-content">
          <div className="article-content-wrapper">
            <div className="space-y-4">
              {[1, 2, 3, 4, 5].map((i) => (
                <div
                  key={i}
                  className="h-4 animate-pulse rounded bg-[var(--color-surface)]"
                  style={{ width: `${60 + i * 8}%` }}
                />
              ))}
            </div>
          </div>
        </article>
      </div>
    </BaseLayout>
  );
}
