import { BaseLayout } from '@/components/BaseLayout';
import { MomentsInfiniteFeed } from '@/components/MomentsInfiniteFeed';
import { PageReady } from '@/components/PageReady';
import { getMoments } from '@/lib/api';
import { USER_NAME } from '@/lib/constants';

export async function MomentsView() {
  let initialMoments: Awaited<ReturnType<typeof getMoments>>['moments'] = [];
  let initialCursor: string | null = null;
  let error: string | null = null;

  try {
    // 1 ページ目のみサーバーで取得し、以降はクライアントの無限スクロールで継ぎ足す
    const page = await getMoments(USER_NAME);
    initialMoments = page.moments;
    initialCursor = page.nextCursor;
  } catch (e) {
    error = e instanceof Error ? e.message : 'Failed to fetch moments';
  }

  if (error) {
    return (
      <BaseLayout showTypeHeader currentTab="moments" narrow>
        <main className="w-full">
          <p className="text-[var(--color-danger-border)]">{error}</p>
          <PageReady />
        </main>
      </BaseLayout>
    );
  }

  return (
    <BaseLayout showTypeHeader currentTab="moments" narrow>
      <main className="w-full">
        {initialMoments.length === 0 ? (
          <p>No moments found.</p>
        ) : (
          <MomentsInfiniteFeed
            userName={USER_NAME}
            initialMoments={initialMoments}
            initialCursor={initialCursor}
          />
        )}
        <PageReady />
      </main>
    </BaseLayout>
  );
}
