import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import type { MomentSummary } from '@/lib/api';
import { MomentCard } from './MomentCard';

// モック写真（Unsplash）。square crop で取得する
const IMG = {
  valley: 'https://images.unsplash.com/photo-1469474968028-56623f02e42e?w=720&h=720&fit=crop&q=70',
  beach: 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=720&h=720&fit=crop&q=70',
  nightCity:
    'https://images.unsplash.com/photo-1477959858617-67f85cf4f1df?w=720&h=720&fit=crop&q=70',
  forest: 'https://images.unsplash.com/photo-1441974231531-c6227db76b6e?w=720&h=720&fit=crop&q=70',
  coffee: 'https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?w=720&h=720&fit=crop&q=70',
  cat: 'https://images.unsplash.com/photo-1518791841217-8f162f1e1131?w=720&h=720&fit=crop&q=70',
};

// モックでは orig / thumb とも同じ URL を使う
const photo = (url: string) => ({ imageUrl: url, thumbUrl: url });

// moment = 180 文字以内の一文 + 写真必須の投稿
const baseMoment: MomentSummary = {
  momentId: 'moment-mock-01',
  text: '仕事帰り、いつもの交差点。信号を待つあいだの空が、今日はやけに広かった。',
  ...photo(IMG.valley),
  capturedAt: '2026-07-12T21:30:00',
};

const meta = {
  title: 'Components/MomentCard',
  component: MomentCard,
  args: {
    moment: baseMoment,
  },
  decorators: [
    // 本番の一覧カラム（BaseLayout narrow の --layout-list-max）と同じ幅に載せる
    (Story) => (
      <div className="w-[var(--layout-list-max)] max-w-[90vw]">
        <Story />
      </div>
    ),
  ],
  parameters: {
    layout: 'centered',
  },
} satisfies Meta<typeof MomentCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

// 留め具 2 種（clip / tape）の比較。投稿ごとに管理画面で選ぶ想定
export const FastenerVariants: Story = {
  render: (args) => (
    <div>
      <MomentCard {...args} moment={{ ...baseMoment, fastener: 'clip' }} />
      <MomentCard
        {...args}
        moment={{
          ...baseMoment,
          momentId: 'moment-mock-05',
          ...photo(IMG.coffee),
          fastener: 'tape',
          fastenerColor: 'yellow',
        }}
        tilt="right"
      />
      <MomentCard
        {...args}
        moment={{
          ...baseMoment,
          momentId: 'moment-mock-04',
          ...photo(IMG.forest),
          fastener: 'tape',
        }}
      />
    </div>
  ),
};

// マスキングテープの色（無指定 = plain + 4 色）。投稿ごとに管理画面で選ぶ想定
export const TapeColors: Story = {
  render: (args) => (
    <div>
      {(['pink', 'blue', 'yellow', 'green', undefined] as const).map((fastenerColor, i) => (
        <MomentCard
          {...args}
          key={fastenerColor ?? 'plain'}
          moment={{
            ...baseMoment,
            momentId: `tape-${fastenerColor ?? 'plain'}`,
            ...photo(Object.values(IMG)[i % 6]),
            fastener: 'tape',
            fastenerColor,
          }}
          tilt={i % 2 === 0 ? 'left' : 'right'}
        />
      ))}
    </div>
  ),
};

export const TiltRight: Story = {
  args: {
    tilt: 'right',
  },
};

export const ShortText: Story = {
  args: {
    moment: {
      ...baseMoment,
      momentId: 'moment-mock-02',
      text: '波の音だけの朝。',
      ...photo(IMG.beach),
    },
  },
};

// text はちょうど 180 文字（上限いっぱい）
export const MaxLength: Story = {
  args: {
    moment: {
      ...baseMoment,
      momentId: 'moment-mock-03',
      text: 'デプロイが終わった深夜三時、ベランダに出て冷たい空気を吸い込んだ。街はもう眠っていて、信号だけが律儀に色を変え続けている。誰にも見られなくても動き続けるものが、この世界にはたくさんあるのだと思ったら、自分の書いたコードが今も静かにリクエストを捌いていることが、ほんの少しだけ誇らしくなった。明日もきっと同じように夜は更けて、同じように新しい朝が来るのだと思う。',
      ...photo(IMG.nightCity),
    },
  },
};
