import { BaseLayout } from '@/components/BaseLayout';

export default function NoteLoading() {
  return (
    <BaseLayout showTypeHeader>
      <main className="w-full">
        <div className="max-w-[var(--layout-list-max)]">
          {[1, 2, 3].map((i) => (
            <div key={i} className="mb-4 h-24 animate-pulse rounded-lg bg-[var(--color-surface)]" />
          ))}
        </div>
      </main>
    </BaseLayout>
  );
}
