import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { useEffect } from 'react';
import type { ArticleSummary, TagFacet } from '@/lib/api';
import { SearchModal } from './SearchModal';
import { SearchProvider, useSearch } from './SearchProvider';
import { TagFilterProvider } from './TagFilterProvider';

const sampleFacets: TagFacet[] = [
  { path: 'tech', count: 65 },
  { path: 'tech/rust', count: 12 },
  { path: 'tech/aws', count: 24 },
  { path: 'misc', count: 48 },
  { path: 'misc/振り返り', count: 18 },
];

const sampleArticles: ArticleSummary[] = Array.from({ length: 8 }, (_, i) => ({
  articleId: `article-${i}`,
  title: `記事タイトル ${i + 1}: サンプル `,
  slug: `article-${i}`,
  description: '',
  thumbnail: null,
  ogpUrl: '',
  tags: [],
  publishedAt: `2026-0${(i % 9) + 1}-15T09:00:00.000Z`,
  createdAt: null,
  updatedAt: null,
}));

function AutoOpen({ children }: { children: React.ReactNode }) {
  const { openModal } = useSearch();
  useEffect(() => {
    openModal();
  }, [openModal]);
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
      <SearchProvider userName="storybook">
        <AutoOpen>{children}</AutoOpen>
      </SearchProvider>
    </TagFilterProvider>
  );
}

const meta = {
  title: 'Components/SearchModal',
  component: SearchModal,
  args: {
    userName: 'storybook',
    defaultArticles: sampleArticles,
    page: 1,
    totalPages: 3,
    baseHref: '/',
  },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof SearchModal>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => (
    <StoryHost>
      <SearchModal {...args} />
    </StoryHost>
  ),
};
