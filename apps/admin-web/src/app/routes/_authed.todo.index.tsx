import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

import { TodoPage } from '@/pages/todo';

const searchSchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

function TodoRoute() {
  const { date } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <TodoPage
      date={date}
      onDateChange={(nextDate) =>
        void navigate({ search: nextDate === undefined ? {} : { date: nextDate } })
      }
    />
  );
}

export const Route = createFileRoute('/_authed/todo/')({
  validateSearch: searchSchema,
  component: TodoRoute,
});
