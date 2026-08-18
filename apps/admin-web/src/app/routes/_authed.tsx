import { createFileRoute, Link, Outlet } from '@tanstack/react-router';

import { AuthGuard, LogoutButton } from '@/features/auth';
import { ButtonLink } from '@/shared/ui/button-link';

// 認証必須領域のレイアウトシェル。pathless レイアウトなので URL に `_authed` は出ない
export const Route = createFileRoute('/_authed')({
  component: AuthedLayout,
});

function AuthedLayout() {
  return (
    <AuthGuard>
      <div className="min-h-dvh">
        <header className="border-b">
          <div className="mx-auto flex h-14 w-full max-w-2xl items-center justify-between px-4">
            <nav className="flex items-center gap-4">
              <Link to="/moments" className="text-sm font-semibold">
                moments
              </Link>
              <Link to="/todo" className="text-sm font-semibold">
                todo
              </Link>
              {/* labs は別 SPA (SvelteKit) なので Router を通さずフルページ遷移 */}
              <a href="/labs/" className="text-sm font-semibold">
                labs
              </a>
              <ButtonLink to="/moments/new" size="sm" data-testid="header-new-moment">
                新規投稿
              </ButtonLink>
            </nav>
            <LogoutButton />
          </div>
        </header>
        <main className="mx-auto w-full max-w-2xl p-4">
          <Outlet />
        </main>
      </div>
    </AuthGuard>
  );
}
