import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { ARTICLE_FULL_HTML } from './__fixtures__/articleFullHtml';
import { ArticleContent } from './ArticleContent';
import { BaseLayout } from './BaseLayout';
import { TableOfContents } from './TableOfContents';

/**
 * 記事ページ（/[userName]/articles/[slug]）の再現 Story。
 * Markdown 変換が生成する全拡張要素（コードブロック各種 / メッセージ / アコーディオン /
 * GitHub 埋め込み / リンクカード / X ポスト / SpeakerDeck 等）を 1 記事に詰め込んでいる。
 * X ポスト・画像・iframe の実体は表示時にネットワークから取得される。
 */
const ArticlePage = () => (
  <BaseLayout>
    <div className="article-header">
      <div className="article-title">全ての拡張要素を埋め込んだサンプル記事</div>
      <div className="article-info">
        <div className="article-time">
          <p>07/11 09:00 2026</p>
          <p>07/12 12:00 2026</p>
        </div>
      </div>
    </div>
    <div className="article-body">
      <article className="article-content">
        <div className="article-content-wrapper">
          <ArticleContent html={ARTICLE_FULL_HTML} />
        </div>
      </article>
      <aside className="right-sidebar">
        <TableOfContents />
      </aside>
    </div>
  </BaseLayout>
);

const meta = {
  title: 'Pages/Article',
  component: ArticlePage,
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta<typeof ArticlePage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AllExtensions: Story = {};
