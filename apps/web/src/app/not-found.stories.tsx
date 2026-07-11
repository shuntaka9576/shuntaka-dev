import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import NotFound from './not-found';

const meta = {
  title: 'Pages/NotFound',
  component: NotFound,
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta<typeof NotFound>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
