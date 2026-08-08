import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { BaseLayout } from '@/components/BaseLayout';
import { MomentCard } from '@/components/MomentCard';
import { PageReady } from '@/components/PageReady';
import type { MomentFastener, MomentFastenerColor, MomentSummary } from '@/lib/api';

// 管理画面（admin.<fqdn>）のプレビューボタンから開く、公開前確認用の 1 枚レンダリング。
// 検索結果に出ないよう noindex にする
export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
  },
};

// プレビューは検索パラメータの内容全体が揃ってから 1 枚を描画する
export const instant = false;

/** 写真 URL は moments の配信ドメイン（prd / dev）のみ許可する */
const ALLOWED_IMAGE_HOSTS = new Set(['images.shuntaka.dev', 'images.shuntaka.tech']);

function parseImageUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (!ALLOWED_IMAGE_HOSTS.has(url.hostname)) return null;
  // next.config.ts の remotePatterns と同じ範囲に絞る
  if (!url.pathname.startsWith('/images/moments/')) return null;
  return url.toString();
}

const FASTENERS: readonly MomentFastener[] = ['clip', 'tape'];
const FASTENER_COLORS: readonly MomentFastenerColor[] = ['pink', 'blue', 'yellow', 'green'];

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

interface PreviewPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function MomentPreviewPage({ searchParams }: PreviewPageProps) {
  const params = await searchParams;

  const imageUrl = parseImageUrl(first(params.img));
  const text = first(params.text) ?? '';
  if (imageUrl === null || text === '') notFound();

  const rawFastener = first(params.fastener);
  const fastener = FASTENERS.find((f) => f === rawFastener) ?? 'clip';
  const rawColor = first(params.color);
  const fastenerColor =
    fastener === 'tape' ? FASTENER_COLORS.find((c) => c === rawColor) : undefined;

  const rawDate = first(params.date);
  // capturedAt は TZ なしのローカル日時。フォールバックも同じ形式 (UTC 現在時刻) に揃える
  const capturedAt =
    rawDate !== undefined && !Number.isNaN(Date.parse(rawDate))
      ? rawDate
      : new Date().toISOString().slice(0, 19);

  const moment: MomentSummary = {
    momentId: 'preview',
    text: text.slice(0, 180),
    imageUrl,
    thumbUrl: imageUrl,
    capturedAt,
    fastener,
    fastenerColor,
  };

  return (
    <BaseLayout showTypeHeader currentTab="moments" narrow>
      <main className="w-full">
        <MomentCard moment={moment} />
        <PageReady />
      </main>
    </BaseLayout>
  );
}
