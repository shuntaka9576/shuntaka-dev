import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import type { ArticleSummary } from '@/lib/api';
import { ArticleCard } from './ArticleCard';

// 実記事「2025年の振り返り」のデータ（サムネイルも本番 API が返す URL そのまま）
const baseArticle: ArticleSummary = {
  articleId: '01HX2YE5PG9N3CK1S3FZ6T2WJK',
  title: '2025年の振り返り',
  slug: '20251224-reflecting-on-2025',
  description: '皆様2025年お疲れさまでした！毎年恒例の振り返りをしました！',
  thumbnail:
    'https://res.cloudinary.com/dkerzyk09/image/upload/v1766782254/blog/20251224-refleting-on-2025/q4acee55zu1k8qoueo0x.webp',
  ogpUrl: '',
  tags: ['misc', 'misc/振り返り', 'tech/rust', 'tech/mcp'],
  publishedAt: '2025-12-26T09:00:00.000Z',
  createdAt: '2025-12-26T09:00:00.000Z',
  updatedAt: '2025-12-26T09:00:00.000Z',
};

const meta = {
  title: 'Components/ArticleCard',
  component: ArticleCard,
  args: {
    userName: 'shuntaka',
    article: baseArticle,
  },
  decorators: [
    // 本番の記事一覧カラム（BaseLayout narrow の --layout-list-max）と同じ幅に載せる。
    // サムネイルは本番では next/image の最適化で 192px 幅に縮むが、Storybook の
    // next/image は素通し（原寸）のため、max-w-48 (192px) で本番の表示幅を再現する
    (Story) => (
      <div className="w-[var(--layout-list-max)] max-w-[90vw] [&_img]:max-w-48">
        <Story />
      </div>
    ),
  ],
  parameters: {
    layout: 'centered',
  },
} satisfies Meta<typeof ArticleCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithThumbnail: Story = {};

export const Priority: Story = {
  args: {
    priority: true,
  },
};

export const NoThumbnail: Story = {
  args: {
    article: { ...baseArticle, thumbnail: null },
  },
};

export const LongTitle: Story = {
  args: {
    article: {
      ...baseArticle,
      title:
        'AWS DSQL に PostgreSQL レイヤーを乗せて Rust + SQLx で書いたバックエンドを動かすときに気をつけたこと',
    },
  },
};

export const NoPublishedAt: Story = {
  args: {
    article: { ...baseArticle, publishedAt: null },
  },
};

export const Filtering: Story = {
  args: {
    tags: [
      { path: 'tech/rust', matched: true },
      { path: 'misc/振り返り', matched: false },
    ],
  },
};
