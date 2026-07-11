import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { useState } from 'react';
import type { TagNode } from '@/lib/tagFilter';
import { TagFilterTree } from './TagFilterTree';

const sampleNodes: TagNode[] = [
  {
    path: 'tech',
    label: 'tech',
    count: 65,
    children: [
      { path: 'tech/rust', label: 'rust', count: 12, children: [] },
      { path: 'tech/tauri', label: 'tauri', count: 8, children: [] },
      { path: 'tech/aws', label: 'aws', count: 24, children: [] },
      { path: 'tech/terminal', label: 'terminal', count: 5, children: [] },
    ],
  },
  {
    path: 'misc',
    label: 'misc',
    count: 48,
    children: [
      { path: 'misc/キャリア', label: 'キャリア', count: 30, children: [] },
      { path: 'misc/振り返り', label: '振り返り', count: 18, children: [] },
    ],
  },
];

function StatefulTree({ initialSelected = [] }: { initialSelected?: string[] }) {
  const [selected, setSelected] = useState<string[]>(initialSelected);
  return (
    <div className="w-80">
      <TagFilterTree
        nodes={sampleNodes}
        selected={selected}
        onToggleTag={(path) =>
          setSelected((prev) =>
            prev.includes(path) ? prev.filter((t) => t !== path) : [...prev, path],
          )
        }
      />
    </div>
  );
}

const meta = {
  title: 'Components/TagFilterTree',
  component: TagFilterTree,
  args: {
    nodes: sampleNodes,
    selected: [],
    onToggleTag: () => {},
  },
  parameters: {
    layout: 'centered',
  },
} satisfies Meta<typeof TagFilterTree>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <StatefulTree />,
};

export const ChildSelected: Story = {
  render: () => <StatefulTree initialSelected={['tech/rust']} />,
};
