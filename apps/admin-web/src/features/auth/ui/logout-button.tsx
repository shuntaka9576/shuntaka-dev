import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';

import { client } from '@/shared/api';
import { Button } from '@/shared/ui/button';

export function LogoutButton() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const logoutMutation = useMutation({
    mutationFn: async () => {
      await client.api.auth.logout.$post();
    },
    onSettled: async () => {
      queryClient.clear();
      await navigate({ to: '/login', replace: true });
    },
  });

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => logoutMutation.mutate()}
      disabled={logoutMutation.isPending}
      data-testid="logout-button"
    >
      ログアウト
    </Button>
  );
}
