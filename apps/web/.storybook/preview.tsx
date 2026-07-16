import { withThemeByDataAttribute } from '@storybook/addon-themes';
import type { Preview } from '@storybook/nextjs-vite';
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-600.css';
import { NavigationProgressProvider } from '../src/components/NavigationProgressProvider';
import { ThemeProvider } from '../src/components/ThemeProvider';
import '../src/app/globals.css';

const preview: Preview = {
  parameters: {
    layout: 'padded',
    backgrounds: { disable: true },
    // BaseLayout (ProgressLink) が useRouter / usePathname を使うため App Router をモックする
    nextjs: { appDirectory: true },
  },
  decorators: [
    withThemeByDataAttribute({
      themes: { light: 'light', dark: 'dark' },
      defaultTheme: 'light',
      attributeName: 'data-theme',
    }),
    (Story) => (
      <ThemeProvider>
        <NavigationProgressProvider>
          <Story />
        </NavigationProgressProvider>
      </ThemeProvider>
    ),
  ],
};

export default preview;
