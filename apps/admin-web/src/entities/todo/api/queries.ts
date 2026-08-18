import { queryOptions } from '@tanstack/react-query';

import { client } from '@/shared/api';

export const todoKeys = { all: ['todo'] as const };

export function todoDashboardQuery() {
  return queryOptions({
    queryKey: todoKeys.all,
    queryFn: async () => {
      const response = await client.api.todo.$get();
      if (!response.ok) throw new Error('todo の取得に失敗しました');
      return response.json();
    },
  });
}
