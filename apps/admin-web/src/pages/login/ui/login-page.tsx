import { LoginForm } from '@/features/auth';
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card';

export function LoginPage() {
  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>shuntaka.dev admin</CardTitle>
        </CardHeader>
        <CardContent>
          <LoginForm />
        </CardContent>
      </Card>
    </div>
  );
}
