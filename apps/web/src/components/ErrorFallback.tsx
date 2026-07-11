import { Button } from './Button';
import { HashiBow } from './HashiBow';

interface ErrorFallbackProps {
  title?: string;
  description?: string;
  /** 指定すると再試行ボタンを表示する */
  onRetry?: () => void;
}

export function ErrorFallback({
  title = 'エラーが発生しました',
  description = '時間をおいて再度お試しください。',
  onRetry,
}: ErrorFallbackProps) {
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4">
      <HashiBow width={139} height={159} />
      <h2 className="text-xl font-bold">{title}</h2>
      <p className="text-[var(--color-text-muted)]">{description}</p>
      {onRetry && (
        <Button variant="secondary" onClick={onRetry}>
          再試行
        </Button>
      )}
    </div>
  );
}
