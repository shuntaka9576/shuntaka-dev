import { useQuery } from '@tanstack/react-query';

import { todoCalendarQuery } from '@/entities/todo';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/shared/ui/button';
import { ButtonLink } from '@/shared/ui/button-link';
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card';
import { Skeleton } from '@/shared/ui/skeleton';

const weekdays = ['日', '月', '火', '水', '木', '金', '土'];

const shiftMonth = (month: string, offset: number): string => {
  const [year = 0, monthNumber = 1] = month.split('-').map(Number);
  const value = new Date(Date.UTC(year, monthNumber - 1 + offset, 1));
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}`;
};

const monthLabel = (month: string): string => {
  const [year, monthNumber] = month.split('-').map(Number);
  return `${year}年${monthNumber}月`;
};

export function TodoCalendarPage({
  month,
  onMonthChange,
  onSelectDate,
}: {
  month?: string;
  onMonthChange: (month?: string) => void;
  onSelectDate: (date: string) => void;
}) {
  const calendar = useQuery(todoCalendarQuery(month));

  if (calendar.isPending) return <Skeleton className="h-96 w-full" />;
  if (calendar.error) return <p className="text-sm text-destructive">{calendar.error.message}</p>;

  const data = calendar.data;
  const [year = 0, monthNumber = 1] = data.month.split('-').map(Number);
  const leadingDays = new Date(Date.UTC(year, monthNumber - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const summaryByDate = new Map(data.days.map((day) => [day.date, day]));
  const cells = [
    ...Array.from<null>({ length: leadingDays }).fill(null),
    ...Array.from({ length: daysInMonth }, (_, index) => index + 1),
  ];

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">todo カレンダー</h1>
        <ButtonLink to="/todo" variant="outline">
          戻る
        </ButtonLink>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle>{monthLabel(data.month)}</CardTitle>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => onMonthChange(shiftMonth(data.month, -1))}
              >
                前月
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={data.month === data.today.slice(0, 7)}
                onClick={() => onMonthChange()}
              >
                今月
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={data.month >= data.today.slice(0, 7)}
                onClick={() => onMonthChange(shiftMonth(data.month, 1))}
              >
                翌月
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-7 gap-1 text-center text-xs text-muted-foreground">
            {weekdays.map((weekday, index) => (
              <div
                key={weekday}
                className={cn(
                  'py-1',
                  index === 0 && 'text-red-500',
                  index === 6 && 'text-blue-500',
                )}
              >
                {weekday}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {cells.map((day, index) => {
              if (day === null) return <div key={`empty-${index}`} aria-hidden="true" />;
              const date = `${data.month}-${String(day).padStart(2, '0')}`;
              const summary = summaryByDate.get(date);
              const isFuture = date > data.today;
              const isToday = date === data.today;
              return (
                <button
                  key={date}
                  type="button"
                  disabled={isFuture}
                  aria-label={`${date}を開く`}
                  onClick={() => onSelectDate(date)}
                  className={cn(
                    'min-h-16 rounded-lg border p-1.5 text-left transition-colors sm:min-h-20 sm:p-2',
                    'hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    isToday && 'border-primary ring-1 ring-primary',
                    isFuture && 'cursor-not-allowed bg-muted/30 text-muted-foreground opacity-50',
                  )}
                >
                  <span className="block text-sm font-medium">{day}</span>
                  {summary === undefined || summary.total === 0 ? (
                    <span className="mt-2 hidden text-xs text-muted-foreground sm:block">
                      未生成
                    </span>
                  ) : (
                    <span className="mt-2 block text-xs text-muted-foreground">
                      {summary.completed}/{summary.total}
                    </span>
                  )}
                  {summary?.hasMorningAchievement === true ? (
                    <span className="mt-1 hidden text-xs font-medium text-primary sm:block">
                      朝活実績あり
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            数字は完了数 / チェック項目数です。日付を選ぶと、その日の一覧を開きます。
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
