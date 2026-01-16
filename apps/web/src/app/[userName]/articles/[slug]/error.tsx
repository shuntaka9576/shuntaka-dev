'use client';

import { useEffect } from 'react';

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
      <p className="mb-4 text-gray-600">{error.message}</p>
      <button
        type="button"
        onClick={() => reset()}
        className="rounded bg-blue-500 px-4 py-2 text-white hover:bg-blue-600"
      >
        再試行
      </button>
    </div>
  );
}
