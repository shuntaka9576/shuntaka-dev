import { queryOptions } from '@tanstack/react-query';

import { client } from '@/shared/api';

export const todoKeys = { all: ['todo'] as const };

export function todoDashboardQuery(date?: string) {
  return queryOptions({
    queryKey: [...todoKeys.all, date ?? 'today'],
    queryFn: async () => {
      const response = await client.api.todo.$get({ query: date === undefined ? {} : { date } });
      if (!response.ok) throw new Error('todo の取得に失敗しました');
      return response.json();
    },
  });
}

export function todoCalendarQuery(month?: string) {
  return queryOptions({
    queryKey: [...todoKeys.all, 'calendar', month ?? 'current'],
    queryFn: async () => {
      const response = await client.api.todo.calendar.$get({
        query: month === undefined ? {} : { month },
      });
      if (!response.ok) throw new Error('カレンダーの取得に失敗しました');
      return response.json();
    },
  });
}
