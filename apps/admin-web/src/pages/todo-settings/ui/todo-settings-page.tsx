import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import { todoDashboardQuery, todoKeys } from '@/entities/todo';
import { parseChecklistMarkdown } from '@/features/todo-settings';
import { client } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { ButtonLink } from '@/shared/ui/button-link';
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
import { Skeleton } from '@/shared/ui/skeleton';
import { Textarea } from '@/shared/ui/textarea';

export function TodoSettingsPage() {
  const dashboard = useQuery(todoDashboardQuery());
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const initialized = useRef(false);
  const [markdown, setMarkdown] = useState('');
  const [generationTime, setGenerationTime] = useState('05:00');
  const [timezone, setTimezone] = useState('Asia/Tokyo');
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (initialized.current || dashboard.data === undefined) return;
    initialized.current = true;
    if (dashboard.data.settings !== null) {
      setMarkdown(dashboard.data.settings.sourceMarkdown);
      setGenerationTime(dashboard.data.settings.generationTime);
      setTimezone(dashboard.data.settings.timezone);
    }
  }, [dashboard.data]);

  const save = useMutation({
    mutationFn: async () => {
      const items = parseChecklistMarkdown(markdown);
      if (items.length === 0) throw new Error('「# 朝」または「# 寝る前」の箇条書きが必要です');
      const response = await client.api.todo.settings.$put({
        json: { timezone, generationTime, sourceMarkdown: markdown, items },
      });
      if (!response.ok) throw new Error('todo 設定の保存に失敗しました');
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: todoKeys.all });
      await navigate({ to: '/todo' });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setValidationError(null);
    const items = parseChecklistMarkdown(markdown);
    if (items.length === 0) {
      setValidationError('「# 朝」または「# 寝る前」の箇条書きが必要です');
      return;
    }
    save.mutate();
  };

  if (dashboard.isPending) return <Skeleton className="h-64 w-full" />;
  if (dashboard.error) return <p className="text-sm text-destructive">{dashboard.error.message}</p>;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">todo 設定</h1>
        <ButtonLink to="/todo" variant="outline">
          戻る
        </ButtonLink>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>毎日のチェックリスト</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <Label className="grid gap-1.5">
                <span>毎朝の生成時刻</span>
                <Input
                  type="time"
                  value={generationTime}
                  onChange={(event) => setGenerationTime(event.target.value)}
                  required
                />
              </Label>
              <Label className="grid gap-1.5">
                <span>タイムゾーン</span>
                <Input
                  value={timezone}
                  onChange={(event) => setTimezone(event.target.value)}
                  required
                />
              </Label>
            </div>

            <Label className="grid gap-1.5">
              <span>チェックリスト本文（Markdown）</span>
              <Textarea
                value={markdown}
                onChange={(event) => setMarkdown(event.target.value)}
                rows={24}
                className="min-h-96 font-mono"
                placeholder={'# 朝\n- 項目\n  - 子項目\n\n# 寝る前\n- 項目'}
              />
            </Label>
            <p className="text-sm text-muted-foreground">
              入力原文はすべて保存し、「# 朝」と「#
              寝る前」の箇条書きを日次チェック項目へ展開します。
              本文は認証済みAPI経由でDBにのみ保存されます。
            </p>
            {(validationError ?? save.error?.message) !== undefined &&
              (validationError ?? save.error?.message) !== null && (
                <p className="text-sm text-destructive">{validationError ?? save.error?.message}</p>
              )}
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? '保存中…' : '保存'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
