import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { ActiveTagBar } from './ActiveTagBar';

const meta = {
  title: 'Components/ActiveTagBar',
  component: ActiveTagBar,
  args: {
    selected: ['rust'],
    mode: 'and',
    hitCount: 12,
    onRemoveTag: () => {},
    onClear: () => {},
  },
  parameters: {
    layout: 'centered',
  },
} satisfies Meta<typeof ActiveTagBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SingleTag: Story = {};

export const MultipleTagsOr: Story = {
  args: {
    selected: ['rust', 'aws/lambda'],
    mode: 'or',
    hitCount: 18,
  },
};

export const MultipleTagsAnd: Story = {
  args: {
    selected: ['rust', 'aws/lambda'],
    mode: 'and',
    hitCount: 3,
  },
};

export const NoHit: Story = {
  args: {
    selected: ['rust', 'k8s'],
    mode: 'and',
    hitCount: 0,
  },
};
