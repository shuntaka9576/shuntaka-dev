import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';

import {
  mealLabels,
  periodLabels,
  quickTodoCategoryLabels,
  todoDashboardQuery,
  todoKeys,
  type DailyTodoItem,
  type MealType,
  type QuickTodoCategory,
  type QuickTodoItem,
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
const addDays = (date: string, days: number): string => {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};
const formatCompletedTime = (completedAt: string, timeZone: string): string =>
  new Intl.DateTimeFormat('ja-JP', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(completedAt));

function ChecklistTree({
  items,
  period,
  onToggle,
  disabled,
  timeZone,
}: {
  items: DailyTodoItem[];
  period: TodoPeriod;
  onToggle: (item: DailyTodoItem) => void;
  disabled: boolean;
  timeZone: string;
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
            <span>
              <span
                className={item.completedAt === null ? '' : 'text-muted-foreground line-through'}
              >
                {item.title}
              </span>
              {item.completedAt === null ? null : (
                <time dateTime={item.completedAt} className="ml-2 text-xs text-muted-foreground">
                  {formatCompletedTime(item.completedAt, timeZone)}
                </time>
              )}
            </span>
          </Label>
          {render(item.itemId)}
        </div>
      ))}
    </div>
  );

  return render(null);
}

function QuickTodoSection({
  category,
  items,
  timeZone,
  disabled,
  onAdd,
  onToggle,
  onDelete,
}: {
  category: QuickTodoCategory;
  items: QuickTodoItem[];
  timeZone: string;
  disabled: boolean;
  onAdd: (category: QuickTodoCategory, title: string) => void;
  onToggle: (item: QuickTodoItem) => void;
  onDelete: (itemId: string) => void;
}) {
  const [title, setTitle] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = title.trim();
    if (value === '') return;
    onAdd(category, value);
    setTitle('');
  };

  return (
    <section className="space-y-3">
      <h2 className="font-semibold">{quickTodoCategoryLabels[category]}</h2>
      <form onSubmit={submit} className="flex gap-2">
        <Input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="TODOを入力"
          aria-label={`${quickTodoCategoryLabels[category]}を入力`}
        />
        <Button type="submit" disabled={disabled || title.trim() === ''}>
          追加
        </Button>
      </form>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">なし</p>
      ) : (
        <ul className="divide-y">
          {items.map((item) => (
            <li key={item.itemId} className="flex items-start justify-between gap-3 py-2">
              <Label className="min-w-0 flex-1 items-start leading-normal font-normal">
                <input
                  type="checkbox"
                  checked={item.completedAt !== null}
                  disabled={disabled}
                  onChange={() => onToggle(item)}
                  className="mt-0.5 size-4 accent-primary"
                />
                <span className="min-w-0">
                  <span
                    className={
                      item.completedAt === null ? '' : 'text-muted-foreground line-through'
                    }
                  >
                    {item.title}
                  </span>
                  {item.completedAt === null ? null : (
                    <time
                      dateTime={item.completedAt}
                      className="ml-2 text-xs text-muted-foreground"
                    >
                      {formatCompletedTime(item.completedAt, timeZone)}
                    </time>
                  )}
                </span>
              </Label>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() => onDelete(item.itemId)}
              >
                削除
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function TodoPage({
  date,
  onDateChange,
}: {
  date?: string;
  onDateChange: (date?: string) => void;
}) {
  const queryClient = useQueryClient();
  const dashboard = useQuery(todoDashboardQuery(date));
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

  const createQuickItem = useMutation({
    mutationFn: async ({ category, title }: { category: QuickTodoCategory; title: string }) => {
      const response = await client.api.todo['quick-items'].$post({ json: { category, title } });
      if (!response.ok) throw new Error('簡単なTODOの追加に失敗しました');
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: todoKeys.all }),
  });

  const toggleQuickItem = useMutation({
    mutationFn: async (item: QuickTodoItem) => {
      const response = await client.api.todo['quick-items'][':id'].$patch({
        param: { id: item.itemId },
        json: { completed: item.completedAt === null },
      });
      if (!response.ok) throw new Error('簡単なTODOの更新に失敗しました');
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: todoKeys.all }),
  });

  const deleteQuickItem = useMutation({
    mutationFn: async (itemId: string) => {
      const response = await client.api.todo['quick-items'][':id'].$delete({
        param: { id: itemId },
      });
      if (!response.ok) throw new Error('簡単なTODOの削除に失敗しました');
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
  const timeZone = data.settings?.timezone ?? 'Asia/Tokyo';
  const mutationError =
    toggleItem.error ??
    createQuickItem.error ??
    toggleQuickItem.error ??
    deleteQuickItem.error ??
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

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => onDateChange(addDays(data.date, -1))}
        >
          前日
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={data.date === data.today}
          onClick={() => onDateChange()}
        >
          今日
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={data.date >= data.today}
          onClick={() => onDateChange(addDays(data.date, 1))}
        >
          翌日
        </Button>
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
                {data.date === data.today
                  ? '本日のチェックリストはまだ生成されていません。'
                  : 'この日のチェックリストはありません。'}
              </p>
              {data.date === data.today ? (
                <Button onClick={() => generate.mutate()} disabled={generate.isPending}>
                  今日の分を生成
                </Button>
              ) : null}
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
                  timeZone={timeZone}
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
          <CardTitle>簡単なTODO</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {(['task', 'blog_idea'] as const).map((category) => (
            <QuickTodoSection
              key={category}
              category={category}
              items={data.quickTodos.filter((item) => item.category === category)}
              timeZone={timeZone}
              disabled={
                createQuickItem.isPending || toggleQuickItem.isPending || deleteQuickItem.isPending
              }
              onAdd={(nextCategory, title) =>
                createQuickItem.mutate({ category: nextCategory, title })
              }
              onToggle={(item) => toggleQuickItem.mutate(item)}
              onDelete={(itemId) => deleteQuickItem.mutate(itemId)}
            />
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
