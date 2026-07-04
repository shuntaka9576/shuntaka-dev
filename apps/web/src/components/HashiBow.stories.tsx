import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { HashiBow } from './HashiBow';

const meta = {
  title: 'Components/HashiBow',
  component: HashiBow,
  parameters: {
    layout: 'centered',
  },
} satisfies Meta<typeof HashiBow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Small: Story = {
  args: {
    width: 93,
    height: 106,
  },
};
