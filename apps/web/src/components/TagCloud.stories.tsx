import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { useState } from 'react';
import type { TagNode } from '@/lib/tagFilter';
import { TagCloud } from './TagCloud';

const sampleNodes: TagNode[] = [
  {
    path: 'tech',
    label: 'tech',
    count: 65,
    children: [
      { path: 'tech/rust', label: 'rust', count: 12, children: [] },
      { path: 'tech/tauri', label: 'tauri', count: 8, children: [] },
      {
        path: 'tech/aws',
        label: 'aws',
        count: 24,
        children: [{ path: 'tech/aws/lambda', label: 'lambda', count: 3, children: [] }],
      },
      { path: 'tech/terminal', label: 'terminal', count: 5, children: [] },
      { path: 'tech/mcp', label: 'mcp', count: 2, children: [] },
    ],
  },
  {
    path: 'misc',
    label: 'misc',
    count: 48,
    children: [
      { path: 'misc/キャリア', label: 'キャリア', count: 30, children: [] },
      { path: 'misc/振り返り', label: '振り返り', count: 18, children: [] },
      { path: 'misc/gadget', label: 'gadget', count: 6, children: [] },
    ],
  },
];

function StatefulCloud({ initialSelected = [] }: { initialSelected?: string[] }) {
  const [selected, setSelected] = useState<string[]>(initialSelected);
  return (
    <div className="w-[min(28rem,90vw)]">
      <TagCloud
        nodes={sampleNodes}
        selected={selected}
        onToggleTag={(path) =>
          setSelected((prev) =>
            prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path],
          )
        }
      />
    </div>
  );
}

const meta = {
  title: 'Components/TagCloud',
  component: TagCloud,
  args: { nodes: sampleNodes, selected: [], onToggleTag: () => {} },
  parameters: { layout: 'centered' },
} satisfies Meta<typeof TagCloud>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <StatefulCloud />,
};

export const WithSelected: Story = {
  render: () => <StatefulCloud initialSelected={['tech/rust', 'misc/キャリア']} />,
};
