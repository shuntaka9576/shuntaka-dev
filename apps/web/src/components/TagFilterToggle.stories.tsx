import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { TagFilterToggle } from './TagFilterToggle';

const meta = {
  title: 'Components/TagFilterToggle',
  component: TagFilterToggle,
  args: {
    open: false,
    active: false,
    onClick: () => {},
    panelId: 'tag-filter-panel',
  },
  parameters: {
    layout: 'centered',
  },
} satisfies Meta<typeof TagFilterToggle>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Open: Story = {
  args: {
    open: true,
  },
};

export const FilteringWithPanelClosed: Story = {
  args: {
    open: false,
    active: true,
  },
};
