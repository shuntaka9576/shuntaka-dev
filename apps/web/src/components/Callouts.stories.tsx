import type { Meta, StoryObj } from '@storybook/nextjs-vite';

const Callouts = () => (
  <div className="prose" style={{ display: 'flex', flexDirection: 'column', maxWidth: 600 }}>
    <div className="message">
      <p>これは warning スタイルのコールアウトです。注意喚起や補足情報に使います。</p>
    </div>
    <div className="message error">
      <p>これは error スタイルのコールアウトです。アクセント色の枠で警告を示します。</p>
    </div>
    <details open>
      <summary>details 内のコールアウト</summary>
      <div className="details-content">
        <p>details 自体を枠で囲み、内側へ message をネストできます。</p>
        <div className="message info">
          <p>ネストされた補足情報です。</p>
        </div>
      </div>
    </details>
  </div>
);

const meta = {
  title: 'Design System/Callouts',
  component: Callouts,
  parameters: {
    layout: 'padded',
  },
} satisfies Meta<typeof Callouts>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
