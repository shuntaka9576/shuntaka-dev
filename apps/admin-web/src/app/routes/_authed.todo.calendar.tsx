import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

import { TodoCalendarPage } from '@/pages/todo-calendar';

const searchSchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(?:0[1-9]|1[0-2])$/)
    .optional(),
});

function TodoCalendarRoute() {
  const { month } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <TodoCalendarPage
      month={month}
      onMonthChange={(nextMonth) =>
        void navigate({ search: nextMonth === undefined ? {} : { month: nextMonth } })
      }
      onSelectDate={(date) => void navigate({ to: '/todo', search: { date } })}
    />
  );
}

export const Route = createFileRoute('/_authed/todo/calendar')({
  validateSearch: searchSchema,
  component: TodoCalendarRoute,
});
