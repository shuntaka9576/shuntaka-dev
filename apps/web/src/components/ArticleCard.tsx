import Image from 'next/image';
import { memo } from 'react';
import type { ArticleSummary } from '@/lib/api';
import { ProgressLink } from './ProgressLink';

export interface ArticleCardTag {
  /** 相対パス表記のタグ（例: "rust", "aws/lambda"） */
  path: string;
  /** 選択中のタグにマッチしているか（強調表示用） */
  matched: boolean;
}

interface ArticleCardProps {
  article: ArticleSummary;
  userName: string;
  priority?: boolean;
  /** タグ絞り込み中のみ渡される。未指定なら通常表示（タイトル + 日付） */
  tags?: ArticleCardTag[];
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

export const ArticleCard = memo(function ArticleCard({
  article,
  userName,
  priority = false,
  tags,
}: ArticleCardProps) {
  return (
    <ProgressLink href={`/${userName}/articles/${article.slug}`}>
      <article className="mb-4 block w-full border-b border-[var(--color-border-subtle)]">
        <div className="mb-2 flex justify-between">
          <div>
            <div className="pt-2 pr-2 pb-4 text-base font-normal">{article.title}</div>
            {tags && tags.length > 0 ? (
              <div className="flex flex-wrap items-baseline gap-x-2 text-xs font-light">
                <span>{formatDate(article.publishedAt)}</span>
                {tags.map((tag) => (
                  <span
                    key={tag.path}
                    className={
                      tag.matched ? 'text-[var(--color-text)]' : 'text-[var(--color-text-muted)]'
                    }
                  >
                    #{tag.path}
                  </span>
                ))}
              </div>
            ) : (
              <div className="text-xs font-light">{formatDate(article.publishedAt)}</div>
            )}
          </div>
          {article.thumbnail && (
            <div>
              {priority ? (
                <Image
                  src={article.thumbnail}
                  alt={article.title}
                  width={150}
                  height={100}
                  className="rounded-[10px] object-cover"
                  style={{ width: 'auto', height: 'auto' }}
                  priority
                />
              ) : (
                <Image
                  src={article.thumbnail}
                  alt={article.title}
                  width={150}
                  height={100}
                  className="rounded-[10px] object-cover"
                  style={{ width: 'auto', height: 'auto' }}
                  loading="lazy"
                />
              )}
            </div>
          )}
        </div>
      </article>
    </ProgressLink>
  );
});
