import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { useCallback, useState } from 'react';
import type { LogSummary } from './LogCard';
import { LogFeed } from './LogFeed';
import { ToggleSwitch } from './ToggleSwitch';

const TEXTS = [
  '仕事帰り、いつもの交差点。信号を待つあいだの空が、今日はやけに広かった。',
  '新しいキーボードが届いた。深夜の部屋に打鍵音だけが響いて、少しだけ強くなれた気がした。',
  '雨上がりのベランダでコーヒーを飲む。湿った風の匂いに、なぜか学生時代の夏を思い出した。',
  'クラスタのLEDが暗闇で点滅している。この小さな箱たちが、今日もブログを支えてくれている。',
  '早起きして誰もいない海へ。波の音を聞いていたら、悩んでいたことがどうでもよくなった。',
  '古い技術書を本棚から引っ張り出した。ページの隅の書き込みが、あの頃の自分からの手紙みたいだった。',
  '終電を逃して歩いた夜道。遠回りの分だけ、月がずっとついてきてくれた。',
  'ラーメン屋の湯気の向こうで、店主が黙々と麺を上げていた。かっこいい仕事とは、こういうことだと思う。',
];

// モック写真（Unsplash）。square crop で取得する
const IMAGES = [
  'photo-1469474968028-56623f02e42e',
  'photo-1507525428034-b723cf961d3e',
  'photo-1477959858617-67f85cf4f1df',
  'photo-1441974231531-c6227db76b6e',
  'photo-1495474472287-4d71bcdd2085',
  'photo-1518791841217-8f162f1e1131',
  'photo-1519681393784-d120267933ba',
  'photo-1470770841072-f978cf4d019e',
];

const FASTENERS = ['clip', 'tape', 'clip', 'tape'] as const;
const FASTENER_COLORS = ['pink', 'yellow', undefined, 'blue', 'green'] as const;

// 新しい順に 1.5 日ずつ遡る決定的なモックデータ。留め具は投稿ごとに選ばれる想定で混在させる
function mockLog(index: number): LogSummary {
  const publishedAt = new Date(
    Date.UTC(2026, 6, 12, 21, 30) - index * 36 * 60 * 60 * 1000,
  ).toISOString();
  return {
    logId: `mock-log-${index}`,
    text: TEXTS[index % TEXTS.length],
    imageUrl: `https://images.unsplash.com/${IMAGES[index % IMAGES.length]}?w=720&h=720&fit=crop&q=70`,
    publishedAt,
    fastener: FASTENERS[index % FASTENERS.length],
    fastenerColor: FASTENER_COLORS[index % FASTENER_COLORS.length],
  };
}

const PAGE_SIZE = 6;
const TOTAL = 30;

// posts のページネーションと異なり logs は無限スクロール。
// 本番では onLoadMore が API のカーソルページングを叩く
function InfiniteFeedDemo() {
  const [logs, setLogs] = useState<LogSummary[]>(() =>
    Array.from({ length: PAGE_SIZE }, (_, i) => mockLog(i)),
  );
  const [loading, setLoading] = useState(false);
  const hasMore = logs.length < TOTAL;

  const loadMore = useCallback(() => {
    setLoading(true);
    setTimeout(() => {
      setLogs((prev) => [
        ...prev,
        ...Array.from({ length: PAGE_SIZE }, (_, i) => mockLog(prev.length + i)),
      ]);
      setLoading(false);
    }, 900);
  }, []);

  return <LogFeed logs={logs} hasMore={hasMore} loading={loading} onLoadMore={loadMore} />;
}

// BaseLayout に logs タブを足したときの見た目のモック。
// 実装時は BaseLayout の currentTab union に 'logs' を追加する
function LogsPageMock() {
  const widthClass = 'max-w-[calc(var(--layout-list-max)+4rem)]';
  return (
    <div className="min-h-screen bg-[var(--color-bg)]">
      <div className="h-12 w-full bg-[var(--color-surface-raised)]">
        <div
          className={`mx-auto flex items-center justify-between px-8 pt-3 pb-1 max-sm:px-4 ${widthClass}`}
        >
          <div className="text-2xl font-semibold">shuntaka.dev</div>
          <ToggleSwitch />
        </div>
      </div>
      <nav className="sticky top-0 z-10 w-full border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)]">
        <div className={`mx-auto flex items-baseline px-8 max-sm:px-4 max-sm:pt-3 ${widthClass}`}>
          <div>
            <div className="mr-2 inline-block">posts</div>
            <div className="mr-2 inline-block border-b-2 border-[var(--color-text)] pb-0.5">
              logs
            </div>
            <div className="mr-2 inline-block">about</div>
          </div>
        </div>
      </nav>
      <div className={`mx-auto px-8 pt-2 pb-8 max-sm:px-4 max-sm:pt-3 ${widthClass}`}>
        <InfiniteFeedDemo />
      </div>
    </div>
  );
}

const meta = {
  title: 'Components/LogFeed',
  component: LogFeed,
  decorators: [
    (Story) => (
      <div className="mx-auto w-[var(--layout-list-max)] max-w-[90vw]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof LogFeed>;

export default meta;
type Story = StoryObj<typeof meta>;

// スクロールすると 900ms の擬似レイテンシでページが継ぎ足される
export const InfiniteScroll: Story = {
  args: {
    logs: [],
    hasMore: true,
    loading: false,
    onLoadMore: () => {},
  },
  render: () => <InfiniteFeedDemo />,
};

export const LoadingSkeleton: Story = {
  args: {
    logs: Array.from({ length: 2 }, (_, i) => mockLog(i)),
    hasMore: true,
    loading: true,
    onLoadMore: () => {},
  },
};

// 末尾に到達すると ochaIcon で静かに終わる
export const EndOfFeed: Story = {
  args: {
    logs: Array.from({ length: 3 }, (_, i) => mockLog(i)),
    hasMore: false,
    loading: false,
    onLoadMore: () => {},
  },
};

// posts / logs / about タブを含むページ全体のイメージ
export const LogsPage: Story = {
  args: {
    logs: [],
    hasMore: true,
    loading: false,
    onLoadMore: () => {},
  },
  render: () => <LogsPageMock />,
  parameters: {
    layout: 'fullscreen',
  },
};
