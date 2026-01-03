import { BaseLayout } from '@/components/BaseLayout';

export default function ArticleLoading() {
  return (
    <BaseLayout>
      <div className="article-header">
        <div
          className="h-10 w-3/4 mx-auto animate-pulse rounded"
          style={{ background: 'var(--article-area-color)' }}
        />
      </div>
      <div className="article-body">
        <article className="article-content">
          <div className="article-content-wrapper">
            <div className="space-y-4">
              {[1, 2, 3, 4, 5].map((i) => (
                <div
                  key={i}
                  className="h-4 animate-pulse rounded"
                  style={{
                    background: 'var(--article-area-color)',
                    width: `${60 + i * 8}%`,
                  }}
                />
              ))}
            </div>
          </div>
        </article>
      </div>
    </BaseLayout>
  );
}
