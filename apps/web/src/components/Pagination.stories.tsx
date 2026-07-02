import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { Pagination } from './Pagination';

const meta = {
  title: 'Components/Pagination',
  component: Pagination,
  args: {
    baseHref: '/',
    currentPage: 1,
    totalPages: 1,
  },
  parameters: {
    layout: 'centered',
  },
} satisfies Meta<typeof Pagination>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SinglePage: Story = {
  args: {
    currentPage: 1,
    totalPages: 1,
  },
};

export const FewPages: Story = {
  args: {
    currentPage: 2,
    totalPages: 4,
  },
};

export const FirstPageOfMany: Story = {
  args: {
    currentPage: 1,
    totalPages: 10,
  },
};

export const MiddlePageOfMany: Story = {
  args: {
    currentPage: 5,
    totalPages: 10,
  },
};

export const LastPageOfMany: Story = {
  args: {
    currentPage: 10,
    totalPages: 10,
  },
};

export const NoteBase: Story = {
  args: {
    baseHref: '/type/note',
    currentPage: 3,
    totalPages: 8,
  },
};
