import { createRootRoute } from '@tanstack/react-router';

import { AppLayout } from '../app-layout';

// ルートルート = アプリのレイアウトシェル (providers + <Outlet />)。
// 認証ガードは /login を素通しするため _authed レイアウトルート側に置く
export const Route = createRootRoute({
  component: AppLayout,
});
