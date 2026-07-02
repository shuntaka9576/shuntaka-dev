import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import type { ArticleSummary } from '@/lib/api';
import { ArticleCard } from './ArticleCard';

const baseArticle: ArticleSummary = {
  articleId: '01HX2YE5PG9N3CK1S3FZ6T2WJK',
  title: 'shuntaka.dev のデザインシステムを skill 化した',
  slug: 'design-system-as-skill',
  description: '',
  type: 'tech',
  thumbnail: 'https://res.cloudinary.com/dkerzyk09/image/upload/v1767101809/blog/og/shuntaka.png',
  ogpUrl: '',
  publishedAt: '2026-04-29T09:00:00.000Z',
  createdAt: '2026-04-29T09:00:00.000Z',
  updatedAt: '2026-04-29T09:00:00.000Z',
};

const meta = {
  title: 'Components/ArticleCard',
  component: ArticleCard,
  args: {
    userName: 'shuntaka',
    article: baseArticle,
  },
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
