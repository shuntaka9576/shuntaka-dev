import { BaseLayout } from '@/components/BaseLayout';

export default function NoteLoading() {
  return (
    <BaseLayout showTypeHeader>
      <main className="w-full">
        <div className="max-w-[600px]">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="mb-4 h-24 animate-pulse rounded-lg"
              style={{ background: 'var(--article-area-color)' }}
            />
          ))}
        </div>
      </main>
    </BaseLayout>
  );
}
