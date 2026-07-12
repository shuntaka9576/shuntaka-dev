import { Outlet } from '@tanstack/react-router';

import { QueryProvider } from './providers/query-provider';

export function AppLayout() {
  return (
    <QueryProvider>
      <Outlet />
    </QueryProvider>
  );
}
