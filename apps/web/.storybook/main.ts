import type { StorybookConfig } from '@storybook/nextjs-vite';

const config: StorybookConfig = {
  stories: ['../src/**/*.stories.@(ts|tsx|mdx)'],
  addons: ['@storybook/addon-themes'],
  framework: {
    name: '@storybook/nextjs-vite',
    options: {},
  },
  staticDirs: ['../public'],
  viteFinal: async (viteConfig) => {
    const base = process.env.STORYBOOK_BASE_PATH;
    if (base) {
      viteConfig.base = base;
    }
    return viteConfig;
  },
};

export default config;
