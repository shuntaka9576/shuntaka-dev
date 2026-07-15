import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { useEffect } from 'react';
import type { TagFacet } from '@/lib/api';
import { TagFilterModal } from './TagFilterModal';
import { TagFilterProvider, useTagFilter } from './TagFilterProvider';

const sampleFacets: TagFacet[] = [
  { path: 'tech', count: 65 },
  { path: 'tech/rust', count: 12 },
  { path: 'tech/aws', count: 24 },
  { path: 'tech/tauri', count: 8 },
  { path: 'misc', count: 48 },
  { path: 'misc/振り返り', count: 18 },
  { path: 'misc/キャリア', count: 30 },
];

function AutoOpen({ children }: { children: React.ReactNode }) {
  const { openTagModal } = useTagFilter();
  useEffect(() => {
    openTagModal();
  }, [openTagModal]);
  return <>{children}</>;
}

function StoryHost({ children }: { children: React.ReactNode }) {
  return (
    <TagFilterProvider
      userName="storybook"
      initialFacets={sampleFacets}
      initialTotalPages={5}
      page={1}
      baseHref="/"
    >
      <AutoOpen>{children}</AutoOpen>
    </TagFilterProvider>
  );
}

const meta = {
  title: 'Components/TagFilterModal',
  component: TagFilterModal,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof TagFilterModal>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <StoryHost>
      <TagFilterModal />
    </StoryHost>
  ),
};
