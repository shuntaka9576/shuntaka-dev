import { createFileRoute } from '@tanstack/react-router';

import { TodoPage } from '@/pages/todo';

export const Route = createFileRoute('/_authed/todo/')({
  component: TodoPage,
});
