import { useQuery } from '@tanstack/react-query';

import { momentQuery } from '@/entities/moment';
import { MomentForm } from '@/features/moment-form';
import { Skeleton } from '@/shared/ui/skeleton';

export function MomentEditPage({ momentId }: { momentId: string }) {
  const query = useQuery(momentQuery(momentId));

  if (query.isPending) {
    return (
      <div className="flex flex-col gap-3" data-testid="moment-edit-loading">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (query.isError) {
    return (
      <p className="text-sm text-destructive" data-testid="moment-edit-error">
        {query.error.message}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-bold">投稿を編集</h1>
      <MomentForm moment={query.data} />
    </div>
  );
}
