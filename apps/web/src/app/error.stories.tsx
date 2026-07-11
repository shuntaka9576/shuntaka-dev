import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import ArticleError from './[userName]/articles/[slug]/error';
import GlobalError from './error';

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

export const Global: Story = {};

export const Article: Story = {
  render: (args) => <ArticleError {...args} />,
  args: {
    error: Object.assign(new Error('記事の取得中にエラーが発生しました'), {
      digest: 'storybook',
    }),
  },
};
