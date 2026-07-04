import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { useState } from 'react';
import type { TagFilterMode, TagNode } from '@/lib/tagFilter';
import { TagFilterPanel } from './TagFilterPanel';

const sampleNodes: TagNode[] = [
  {
    path: 'aws',
    label: 'aws',
    count: 24,
    children: [
      { path: 'aws/lambda', label: 'lambda', count: 9, children: [] },
      { path: 'aws/cdk', label: 'cdk', count: 7, children: [] },
      { path: 'aws/dsql', label: 'dsql', count: 3, children: [] },
    ],
  },
  { path: 'rust', label: 'rust', count: 12, children: [] },
  { path: 'claude-code', label: 'claude-code', count: 8, children: [] },
  { path: 'terminal', label: 'terminal', count: 5, children: [] },
  { path: 'k8s', label: 'k8s', count: 3, children: [] },
];

function StatefulPanel({
  initialSelected = [],
  initialMode = 'and',
}: {
  initialSelected?: string[];
  initialMode?: TagFilterMode;
}) {
  const [selected, setSelected] = useState<string[]>(initialSelected);
  const [mode, setMode] = useState<TagFilterMode>(initialMode);
  return (
    <div className="w-[600px] max-w-full">
      <TagFilterPanel
        id="tag-filter-panel"
        nodes={sampleNodes}
        selected={selected}
        mode={mode}
        onToggleTag={(path) =>
          setSelected((prev) =>
            prev.includes(path) ? prev.filter((t) => t !== path) : [...prev, path],
          )
        }
        onModeChange={setMode}
      />
    </div>
  );
}

const meta = {
  title: 'Components/TagFilterPanel',
  component: TagFilterPanel,
  args: {
    id: 'tag-filter-panel',
    nodes: sampleNodes,
    selected: [],
    mode: 'and',
    onToggleTag: () => {},
    onModeChange: () => {},
  },
  parameters: {
    layout: 'centered',
  },
} satisfies Meta<typeof TagFilterPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <StatefulPanel />,
};

export const SingleSelected: Story = {
  render: () => <StatefulPanel initialSelected={['rust']} />,
};

export const MultipleSelectedWithModeToggle: Story = {
  render: () => <StatefulPanel initialSelected={['rust', 'aws']} initialMode="or" />,
};
