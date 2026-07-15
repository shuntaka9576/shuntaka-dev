import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { useState } from 'react';
import { SearchInput } from './SearchInput';

function StatefulInput({
  initialValue = '',
  loading = false,
}: {
  initialValue?: string;
  loading?: boolean;
}) {
  const [value, setValue] = useState(initialValue);
  return (
    <div className="w-80">
      <SearchInput
        value={value}
        onChange={setValue}
        onClear={() => setValue('')}
        loading={loading}
      />
    </div>
  );
}

const meta = {
  title: 'Components/SearchInput',
  component: SearchInput,
  args: {
    value: '',
    onChange: () => {},
    onClear: () => {},
  },
  parameters: { layout: 'centered' },
} satisfies Meta<typeof SearchInput>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {
  render: () => <StatefulInput />,
};

export const WithValue: Story = {
  render: () => <StatefulInput initialValue="TiDB Vector検索" />,
};

export const Loading: Story = {
  render: () => <StatefulInput initialValue="Rust Axum" loading />,
};
