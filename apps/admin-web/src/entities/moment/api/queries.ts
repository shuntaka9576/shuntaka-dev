import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';

import { client } from '@/shared/api';

export const momentKeys = {
  all: ['moments'] as const,
  lists: () => [...momentKeys.all, 'list'] as const,
  detail: (momentId: string) => [...momentKeys.all, 'detail', momentId] as const,
};

export function momentQuery(momentId: string) {
  return queryOptions({
    queryKey: momentKeys.detail(momentId),
    queryFn: async () => {
      const res = await client.api.moments[':id'].$get({ param: { id: momentId } });
      if (!res.ok) throw new Error('moment の取得に失敗しました');
      return res.json();
    },
  });
}

export function momentListInfiniteQuery() {
  return infiniteQueryOptions({
    queryKey: momentKeys.lists(),
    queryFn: async ({ pageParam }) => {
      const res = await client.api.moments.$get({
        query: pageParam !== undefined ? { cursor: pageParam } : {},
      });
      if (!res.ok) throw new Error('moments の取得に失敗しました');
      return res.json();
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}
