import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { type ReactNode, useEffect } from 'react';

import { UnauthorizedError, sessionQuery } from '@/entities/session';

// 認証必須領域のガード。セッション無効 (401) なら /login へ置き換え遷移する
export function AuthGuard({ children }: { children: ReactNode }) {
  const { error, isPending } = useQuery(sessionQuery());
  const navigate = useNavigate();
  const unauthorized = error instanceof UnauthorizedError;

  useEffect(() => {
    if (unauthorized) {
      void navigate({ to: '/login', replace: true });
    }
  }, [unauthorized, navigate]);

  if (isPending || unauthorized) return null;
  if (error) {
    return <p className="p-6 text-sm text-destructive">{error.message}</p>;
  }
  return <>{children}</>;
}
