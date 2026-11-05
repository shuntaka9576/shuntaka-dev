import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { ArticleContent } from './ArticleContent';

const meta = {
  title: 'Components/ArticleContent',
  component: ArticleContent,
} satisfies Meta<typeof ArticleContent>;

export default meta;
type Story = StoryObj<typeof meta>;

// comrak + syntect の出力と同じく、言語は pre の lang 属性に入る。
export const Mermaid: Story = {
  args: {
    html: `<h2>フローチャート</h2>
<pre lang="mermaid"><code>flowchart LR
  A[記事を書く] --&gt; B[保存する] --&gt; C[公開する]
</code></pre>
<h2>シーケンス図</h2>
<pre lang="mermaid"><code>sequenceDiagram
  participant U as 読者
  participant W as Web
  participant A as API
  U-&gt;&gt;W: 記事を開く
  W-&gt;&gt;A: 記事取得
  A--&gt;&gt;W: HTML
  W--&gt;&gt;U: 図を表示
</code></pre>
<h2>構文エラー</h2>
<pre lang="mermaid"><code>this is not a diagram</code></pre>
<h2>通常のコード</h2>
<pre lang="rust"><code>fn main() {}</code></pre>`,
  },
};

export const WideMermaid: Story = {
  args: {
    html: `<pre lang="mermaid"><code>flowchart LR
  A[要件を確認する] --&gt; B[設計する] --&gt; C[実装する] --&gt; D[テストする] --&gt; E[レビューする] --&gt; F[リリースする] --&gt; G[動作を確認する]
</code></pre>`,
  },
};

export const KnowledgeGraph: Story = {
  args: {
    html: `<pre lang="mermaid"><code>flowchart TD
    A["非構造化データ&lt;br/&gt;ニュース・文書など"]
    B["NER&lt;br/&gt;固有表現抽出"]
    C["RE&lt;br/&gt;関係抽出"]
    D["Entity Resolution&lt;br/&gt;エンティティの名寄せ"]
    E["Knowledge Graph&lt;br/&gt;ノードとエッジを保存"]
    F["Graph Modeling&lt;br/&gt;スキーマ・関係タイプの設計"]

    A --&gt; B
    B --&gt;|"ノード候補"| C
    C --&gt;|"エッジ候補"| D
    D --&gt;|"統合済みのエンティティ・関係"| E

    F -.-&gt;|"抽出対象・型を定義"| B
    F -.-&gt;|"関係タイプを定義"| C
    F -.-&gt;|"識別・統合ルール"| D
    F -.-&gt;|"保存構造を定義"| E

    classDef source fill:#f1f5f9,stroke:#64748b,color:#334155
    classDef process fill:#dbeafe,stroke:#2563eb,color:#1e40af
    classDef model fill:#fef3c7,stroke:#d97706,color:#92400e
    classDef result fill:#dcfce7,stroke:#16a34a,color:#166534

    class A source
    class B,C,D process
    class F model
    class E result
</code></pre>`,
  },
};
