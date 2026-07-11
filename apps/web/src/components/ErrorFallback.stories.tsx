import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { ErrorFallback } from './ErrorFallback';

const meta = {
  title: 'Components/ErrorFallback',
  component: ErrorFallback,
} satisfies Meta<typeof ErrorFallback>;

export default meta;
type Story = StoryObj<typeof meta>;

/** エラーバウンダリ (error.tsx) で使う形。再試行ボタンあり */
export const WithRetry: Story = {
  args: {
    onRetry: () => {},
  },
};

/** 404 (not-found.tsx) で使う形。再試行ボタンなし */
export const NotFound: Story = {
  args: {
    title: 'ページが見つかりませんでした',
    description: 'このページはすでに削除されているか、URLが間違っている可能性があります。',
  },
};
