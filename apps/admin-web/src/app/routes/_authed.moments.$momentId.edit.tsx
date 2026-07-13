import { createFileRoute } from '@tanstack/react-router';

import { MomentEditPage } from '@/pages/moment-edit';

export const Route = createFileRoute('/_authed/moments/$momentId/edit')({
  component: RouteComponent,
});

function RouteComponent() {
  const { momentId } = Route.useParams();
  return <MomentEditPage momentId={momentId} />;
}
