import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';

import {
  mealLabels,
  periodLabels,
  todoDashboardQuery,
  todoKeys,
  type DailyTodoItem,
  type MealType,
  type TodoPeriod,
} from '@/entities/todo';
import { client } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { ButtonLink } from '@/shared/ui/button-link';
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
import { Skeleton } from '@/shared/ui/skeleton';

const formatDate = (date: string): string => date.replaceAll('-', '/');

function ChecklistTree({
  items,
  period,
  onToggle,
  disabled,
}: {
  items: DailyTodoItem[];
  period: TodoPeriod;
  onToggle: (item: DailyTodoItem) => void;
  disabled: boolean;
}) {
  const children = new Map<string | null, DailyTodoItem[]>();
  for (const item of items.filter((candidate) => candidate.period === period)) {
    const siblings = children.get(item.parentItemId) ?? [];
    siblings.push(item);
    children.set(item.parentItemId, siblings);
  }
  for (const siblings of children.values()) siblings.sort((a, b) => a.position - b.position);

  const render = (parentId: string | null): React.ReactNode => (
    <div className={parentId === null ? 'space-y-2' : 'mt-2 ml-6 space-y-2'}>
      {(children.get(parentId) ?? []).map((item) => (
        <div key={item.itemId}>
          <Label className="items-start leading-normal font-normal">
            <input
              type="checkbox"
              checked={item.completedAt !== null}
              disabled={disabled}
              onChange={() => onToggle(item)}
              className="mt-0.5 size-4 accent-primary"
            />
            <span className={item.completedAt === null ? '' : 'text-muted-foreground line-through'}>
              {item.title}
            </span>
          </Label>
          {render(item.itemId)}
        </div>
      ))}
    </div>
  );

  return render(null);
}

export function TodoPage() {
  const queryClient = useQueryClient();
  const dashboard = useQuery(todoDashboardQuery());
  const [shoppingName, setShoppingName] = useState('');
  const [shoppingQuantity, setShoppingQuantity] = useState('');

  const toggleItem = useMutation({
    mutationFn: async (item: DailyTodoItem) => {
      const response = await client.api.todo.items[':id'].$patch({
        param: { id: item.itemId },
        json: { completed: item.completedAt === null },
      });
      if (!response.ok) throw new Error('チェック状態の更新に失敗しました');
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: todoKeys.all }),
  });

  const generate = useMutation({
    mutationFn: async () => {
      const response = await client.api.todo.generate.$post();
      if (!response.ok) throw new Error('チェックリストの生成に失敗しました');
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: todoKeys.all }),
  });

  const updateMeal = useMutation({
    mutationFn: async ({
      date,
      type,
      content,
    }: {
      date: string;
      type: MealType;
      content: string;
    }) => {
      const response = await client.api.todo.meals[':date'][':type'].$put({
        param: { date, type },
        json: { content },
      });
      if (!response.ok) throw new Error('献立の更新に失敗しました');
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: todoKeys.all }),
  });

  const addShopping = useMutation({
    mutationFn: async () => {
      const response = await client.api.todo.shopping.$post({
        json: {
          name: shoppingName,
          ...(shoppingQuantity.trim() === '' ? {} : { quantity: shoppingQuantity }),
        },
      });
      if (!response.ok) throw new Error('買い物項目の追加に失敗しました');
    },
    onSuccess: async () => {
      setShoppingName('');
      setShoppingQuantity('');
      await queryClient.invalidateQueries({ queryKey: todoKeys.all });
    },
  });

  const deleteShopping = useMutation({
    mutationFn: async (itemId: string) => {
      const response = await client.api.todo.shopping[':id'].$delete({ param: { id: itemId } });
      if (!response.ok) throw new Error('買い物項目の削除に失敗しました');
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: todoKeys.all }),
  });

  const submitShopping = (event: FormEvent) => {
    event.preventDefault();
    if (shoppingName.trim() !== '') addShopping.mutate();
  };

  if (dashboard.isPending) return <Skeleton className="h-64 w-full" />;
  if (dashboard.error) return <p className="text-sm text-destructive">{dashboard.error.message}</p>;

  const data = dashboard.data;
  const mutationError =
    toggleItem.error ??
    generate.error ??
    updateMeal.error ??
    addShopping.error ??
    deleteShopping.error;

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">todo</h1>
          <p className="mt-1 text-sm text-muted-foreground">{formatDate(data.date)}</p>
        </div>
        <ButtonLink to="/todo/settings" variant="outline">
          設定
        </ButtonLink>
      </div>

      {mutationError !== null && (
        <p className="text-sm text-destructive">{mutationError.message}</p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>1. チェックリスト</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {data.settings === null ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">チェックリストが未設定です。</p>
              <ButtonLink to="/todo/settings">設定する</ButtonLink>
            </div>
          ) : data.checklist.length === 0 ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                本日のチェックリストはまだ生成されていません。
              </p>
              <Button onClick={() => generate.mutate()} disabled={generate.isPending}>
                今日の分を生成
              </Button>
            </div>
          ) : (
            (['morning', 'bedtime'] as const).map((period) => (
              <section key={period}>
                <h2 className="mb-3 text-base font-semibold">{periodLabels[period]}</h2>
                <ChecklistTree
                  items={data.checklist}
                  period={period}
                  onToggle={(item) => toggleItem.mutate(item)}
                  disabled={toggleItem.isPending}
                />
              </section>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>2. 直近の献立リスト</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {data.meals.map((day) => (
            <section key={day.date}>
              <h2 className="mb-2 text-sm font-semibold">{formatDate(day.date)}</h2>
              <div className="grid gap-2 sm:grid-cols-3">
                {(Object.keys(mealLabels) as MealType[]).map((type) => (
                  <Label key={type} className="grid gap-1.5">
                    <span>{mealLabels[type]}</span>
                    <Input
                      key={`${day.date}-${type}-${day[type] ?? ''}`}
                      defaultValue={day[type] ?? ''}
                      placeholder="未定"
                      onBlur={(event) => {
                        const content = event.currentTarget.value.trim();
                        if (content !== (day[type] ?? '')) {
                          updateMeal.mutate({ date: day.date, type, content });
                        }
                      }}
                    />
                  </Label>
                ))}
              </div>
            </section>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>3. 買い物リスト</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <form onSubmit={submitShopping} className="grid gap-2 sm:grid-cols-[1fr_8rem_auto]">
            <Input
              value={shoppingName}
              onChange={(event) => setShoppingName(event.target.value)}
              placeholder="品名"
              aria-label="品名"
            />
            <Input
              value={shoppingQuantity}
              onChange={(event) => setShoppingQuantity(event.target.value)}
              placeholder="数量（任意）"
              aria-label="数量"
            />
            <Button type="submit" disabled={addShopping.isPending || shoppingName.trim() === ''}>
              追加
            </Button>
          </form>
          {data.shopping.length === 0 ? (
            <p className="text-sm text-muted-foreground">買い物リスト：なし</p>
          ) : (
            <ul className="divide-y">
              {data.shopping.map((item) => (
                <li key={item.itemId} className="flex items-center justify-between gap-3 py-2">
                  <span className="text-sm">
                    {item.name}
                    {item.quantity === null ? '' : `（${item.quantity}）`}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={deleteShopping.isPending}
                    onClick={() => deleteShopping.mutate(item.itemId)}
                  >
                    完了・除外
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
