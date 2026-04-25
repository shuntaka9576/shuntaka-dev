import Image from 'next/image';
import { memo } from 'react';
import type { Article } from '@/lib/api';
import { ProgressLink } from './ProgressLink';

interface ArticleCardProps {
  article: Article;
  userName: string;
}

function formatDate(dateString: string | null): string {
  if (!dateString) return '';
  const date = new Date(dateString);
  return date.toLocaleDateString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

export const ArticleCard = memo(function ArticleCard({ article, userName }: ArticleCardProps) {
  return (
    <ProgressLink href={`/${userName}/articles/${article.slug}`}>
      <article className="mb-4 block w-full border-b border-[var(--color-border-subtle)]">
        <div className="mb-2 flex justify-between">
          <div>
            <div className="pt-2 pr-2 pb-4 text-base">{article.title}</div>
            <div className="text-xs">{formatDate(article.publishedAt)}</div>
          </div>
          {article.thumbnail && (
            <div>
              <Image
                src={article.thumbnail}
                alt={article.title}
                width={150}
                height={100}
                className="rounded-[10px] object-cover"
                loading="lazy"
              />
            </div>
          )}
        </div>
      </article>
    </ProgressLink>
  );
});
