import { MomentForm } from '@/features/moment-form';

export function MomentNewPage() {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-bold">新規投稿</h1>
      <MomentForm />
    </div>
  );
}
