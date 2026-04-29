import type { Meta, StoryObj } from '@storybook/nextjs-vite';

const Callouts = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: 600 }}>
    <div className="message">
      <p>これは warning スタイルのコールアウトです。注意喚起や補足情報に使います。</p>
    </div>
    <div className="message error">
      <p>これは error スタイルのコールアウトです。アクセント色の枠で警告を示します。</p>
    </div>
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
