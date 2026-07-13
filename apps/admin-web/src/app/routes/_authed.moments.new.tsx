import { createFileRoute } from '@tanstack/react-router';

import { MomentNewPage } from '@/pages/moment-new';

export const Route = createFileRoute('/_authed/moments/new')({
  component: MomentNewPage,
});
