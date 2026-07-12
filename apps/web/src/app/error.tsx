'use client';

import { useEffect } from 'react';
import { BaseLayout } from '@/components/BaseLayout';
import { ErrorFallback } from '@/components/ErrorFallback';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Application error:', error);
  }, [error]);

  return (
    <BaseLayout>
      <ErrorFallback onRetry={() => reset()} />
    </BaseLayout>
  );
}
