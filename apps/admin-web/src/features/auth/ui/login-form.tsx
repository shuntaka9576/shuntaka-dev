import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';

import { sessionKeys } from '@/entities/session';
import { client } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';

import { srpLogin } from '../lib/srp';

export function LoginForm() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const loginMutation = useMutation({
    mutationFn: async () => {
      // SRP でトークンを取得し、バックエンドで Cookie セッションに引き換える。
      // トークンはブラウザの storage に保持しない
      const tokens = await srpLogin(username, password);
      const res = await client.api.auth.login.$post({ json: tokens });
      if (!res.ok) throw new Error('ログインに失敗しました');
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: sessionKeys.all });
      await navigate({ to: '/moments', replace: true });
    },
  });

  return (
    <form
      className="flex flex-col gap-4"
      data-testid="login-form"
      onSubmit={(e) => {
        e.preventDefault();
        loginMutation.mutate();
      }}
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor="login-username">ユーザー名</Label>
        <Input
          id="login-username"
          autoComplete="username"
          required
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          data-testid="login-username"
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="login-password">パスワード</Label>
        <Input
          id="login-password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          data-testid="login-password"
        />
      </div>
      {loginMutation.isError && (
        <p className="text-sm text-destructive" data-testid="login-error">
          {loginMutation.error.message}
        </p>
      )}
      <Button type="submit" disabled={loginMutation.isPending} data-testid="login-submit">
        {loginMutation.isPending ? 'ログイン中…' : 'ログイン'}
      </Button>
    </form>
  );
}
