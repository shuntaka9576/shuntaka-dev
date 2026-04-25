'use client';

import { useEffect } from 'react';
import { Button } from '@/components/Button';

export default function ArticleError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Article error:', error);
  }, [error]);

  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center">
      <h2 className="mb-4 text-xl font-bold">記事の読み込みに失敗しました</h2>
      <p className="mb-4 text-[var(--color-text-muted)]">{error.message}</p>
      <Button variant="primary" onClick={() => reset()}>
        再試行
      </Button>
    </div>
  );
}
