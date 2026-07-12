import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import GlobalError from './error';

// 記事エラー ([userName]/articles/[slug]/error.tsx) も同じ ErrorFallback を描画するため、
// ページ Story は BaseLayout との配線確認としてこの 1 本のみ。
// 見た目の variant は Components/ErrorFallback を参照
const meta = {
  title: 'Pages/Error',
  component: GlobalError,
  parameters: {
    layout: 'fullscreen',
  },
  args: {
    error: Object.assign(new Error('Internal Server Error'), {
      digest: 'storybook',
    }),
    reset: () => {},
  },
} satisfies Meta<typeof GlobalError>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
