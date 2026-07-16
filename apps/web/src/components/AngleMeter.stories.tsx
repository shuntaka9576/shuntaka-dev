import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { AngleMeter } from './AngleMeter';

const meta = {
  title: 'Components/AngleMeter',
  component: AngleMeter,
  args: { distance: 0.35 },
  parameters: { layout: 'centered' },
} satisfies Meta<typeof AngleMeter>;

export default meta;
type Story = StoryObj<typeof meta>;

export const High: Story = { args: { distance: 0.15 } };
export const Medium: Story = { args: { distance: 0.5 } };
export const Low: Story = { args: { distance: 1.2 } };

export const Stack: Story = {
  render: () => (
    <div className="flex flex-col gap-2">
      {[0.1, 0.35, 0.6, 1.0, 1.7].map((d) => (
        <div key={d} className="flex items-center gap-3">
          <span className="w-24 text-[length:var(--fs-caption)] text-[var(--color-text-muted)]">
            distance={d}
          </span>
          <AngleMeter distance={d} />
        </div>
      ))}
    </div>
  ),
};
