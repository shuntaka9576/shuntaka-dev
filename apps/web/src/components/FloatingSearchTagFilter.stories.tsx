import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import type { TagFacet } from '@/lib/api';
import { FloatingSearchTagFilter } from './FloatingSearchTagFilter';
import { SearchProvider } from './SearchProvider';
import { TagFilterProvider } from './TagFilterProvider';

const sampleFacets: TagFacet[] = [
  { path: 'tech', count: 65 },
  { path: 'tech/rust', count: 12 },
  { path: 'tech/tauri', count: 8 },
  { path: 'tech/aws', count: 24 },
  { path: 'misc', count: 48 },
  { path: 'misc/キャリア', count: 30 },
  { path: 'misc/振り返り', count: 18 },
];

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
        {/* パネル展開余地を確保するための下端スペーサ */}
        <div className="relative min-h-[420px] w-[min(24rem,90vw)]">{children}</div>
      </SearchProvider>
    </TagFilterProvider>
  );
}

const meta = {
  title: 'Components/FloatingSearchTagFilter',
  component: FloatingSearchTagFilter,
  args: { userName: 'storybook' },
  parameters: { layout: 'centered' },
} satisfies Meta<typeof FloatingSearchTagFilter>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * デフォルト状態: パネル閉、検索クエリ / タグ選択どちらも無い。
 * ピルをクリックすると Ask / Tag タブが切り替わる。
 */
export const Default: Story = {
  render: (args) => (
    <StoryHost>
      <FloatingSearchTagFilter {...args} />
    </StoryHost>
  ),
};
