import type { InferResponseType } from 'hono/client';

import { client } from '@/shared/api';

export type TodoDashboard = InferResponseType<typeof client.api.todo.$get, 200>;
export type DailyTodoItem = TodoDashboard['checklist'][number];
export type QuickTodoItem = TodoDashboard['quickTodos'][number];
export type ShoppingItem = TodoDashboard['shopping'][number];
export type QuickTodoCategory = QuickTodoItem['category'];
export type TodoPeriod = DailyTodoItem['period'];
export type MealType = 'breakfast' | 'lunch' | 'dinner';

export const periodLabels: Record<TodoPeriod, string> = {
  morning: '朝',
  bedtime: '寝る前',
};

export const mealLabels: Record<MealType, string> = {
  breakfast: '朝',
  lunch: '昼',
  dinner: '夜',
};

export const quickTodoCategoryLabels: Record<QuickTodoCategory, string> = {
  task: 'やるべきこと',
  blog_idea: 'ブログネタ',
};
