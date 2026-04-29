import type { Meta, StoryObj } from '@storybook/nextjs-vite';

const Swatch = ({ name, value }: { name: string; value: string }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
    <div
      style={{
        width: 32,
        height: 32,
        borderRadius: 'var(--radius-sm)',
        border: '1px solid var(--color-border)',
        background: value,
      }}
    />
    <code style={{ fontSize: '0.8125rem' }}>{name}</code>
    <span style={{ fontSize: '0.8125rem', color: 'var(--color-text-muted)' }}>{value}</span>
  </div>
);

const Colors = () => (
  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem 2rem' }}>
    <Swatch name="--color-bg" value="var(--color-bg)" />
    <Swatch name="--color-surface" value="var(--color-surface)" />
    <Swatch name="--color-surface-raised" value="var(--color-surface-raised)" />
    <Swatch name="--color-text" value="var(--color-text)" />
    <Swatch name="--color-border" value="var(--color-border)" />
    <Swatch name="--color-accent" value="var(--color-accent)" />
    <Swatch name="--color-accent-alt" value="var(--color-accent-alt)" />
    <Swatch name="--color-link" value="var(--color-link)" />
    <Swatch name="--color-info-border" value="var(--color-info-border)" />
    <Swatch name="--color-success-border" value="var(--color-success-border)" />
    <Swatch name="--color-warning-border" value="var(--color-warning-border)" />
    <Swatch name="--color-danger-border" value="var(--color-danger-border)" />
  </div>
);

const Radii = () => {
  const radii = [
    ['--radius-sm', 'var(--radius-sm)'],
    ['--radius-md', 'var(--radius-md)'],
    ['--radius-lg', 'var(--radius-lg)'],
    ['--radius-full', 'var(--radius-full)'],
  ] as const;
  return (
    <div style={{ display: 'flex', gap: '1.5rem' }}>
      {radii.map(([name, value]) => (
        <div key={name} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <div
            style={{
              width: 64,
              height: 64,
              background: 'var(--color-accent)',
              borderRadius: value,
            }}
          />
          <code style={{ fontSize: '0.75rem' }}>{name}</code>
        </div>
      ))}
    </div>
  );
};

const Typography = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
    <span style={{ fontSize: 'var(--fs-display)' }}>Display 32px</span>
    <span style={{ fontSize: 'var(--fs-h1)' }}>H1 27.2px</span>
    <span style={{ fontSize: 'var(--fs-h2)' }}>H2 24px</span>
    <span style={{ fontSize: 'var(--fs-h3)' }}>H3 20px</span>
    <span style={{ fontSize: 'var(--fs-body-lg)' }}>Body lg 16px</span>
    <span style={{ fontSize: 'var(--fs-body)' }}>Body 15px</span>
    <span style={{ fontSize: 'var(--fs-caption) ' }}>Caption 13px</span>
  </div>
);

const meta = {
  title: 'Design System/Tokens',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const ColorPalette: Story = { render: () => <Colors /> };
export const RadiusScale: Story = { render: () => <Radii /> };
export const TypeScale: Story = { render: () => <Typography /> };
