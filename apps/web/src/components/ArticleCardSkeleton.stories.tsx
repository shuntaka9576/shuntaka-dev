import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { ArticleCardSkeleton, ArticleCardSkeletonList } from './ArticleCardSkeleton';

const meta = {
  title: 'Components/ArticleCardSkeleton',
  component: ArticleCardSkeleton,
  decorators: [
    (Story) => (
      <div className="w-[var(--layout-list-max)] max-w-[90vw]">
        <Story />
      </div>
    ),
  ],
  parameters: { layout: 'centered' },
} satisfies Meta<typeof ArticleCardSkeleton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Single: Story = {};

export const SingleNoThumb: Story = {
  args: { withThumbnail: false },
};

export const List: Story = {
  render: () => <ArticleCardSkeletonList count={5} />,
};
