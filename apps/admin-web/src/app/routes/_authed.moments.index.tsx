import { createFileRoute } from '@tanstack/react-router';

import { MomentsPage } from '@/pages/moments';

export const Route = createFileRoute('/_authed/moments/')({
  component: MomentsPage,
});
