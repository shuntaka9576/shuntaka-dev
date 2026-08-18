import { createFileRoute } from '@tanstack/react-router';

import { TodoSettingsPage } from '@/pages/todo-settings';

export const Route = createFileRoute('/_authed/todo/settings')({
  component: TodoSettingsPage,
});
