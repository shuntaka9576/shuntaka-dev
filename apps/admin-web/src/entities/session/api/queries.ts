import { queryOptions } from '@tanstack/react-query';

import { client } from '@/shared/api';

import { UnauthorizedError } from '../lib/unauthorized-error';

export const sessionKeys = {
  all: ['session'] as const,
};

export function sessionQuery() {
  return queryOptions({
    queryKey: sessionKeys.all,
    queryFn: async () => {
      const res = await client.api.me.$get();
      // 型上は 200 のみだが、実際は認証ミドルウェアが 401 を返しうる
      if (!res.ok) throw new UnauthorizedError();
      return res.json();
    },
    retry: false,
    staleTime: 5 * 60 * 1000,
  });
}
