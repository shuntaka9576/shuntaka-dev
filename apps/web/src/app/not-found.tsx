import { BaseLayout } from '@/components/BaseLayout';
import { ErrorFallback } from '@/components/ErrorFallback';

export default function NotFound() {
  return (
    <BaseLayout>
      <ErrorFallback
        title="ページが見つかりませんでした"
        description="このページはすでに削除されているか、URLが間違っている可能性があります。"
      />
    </BaseLayout>
  );
}
