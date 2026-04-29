import { withThemeByDataAttribute } from '@storybook/addon-themes';
import type { Preview } from '@storybook/nextjs-vite';
import { NavigationProgressProvider } from '../src/components/NavigationProgressProvider';
import { ThemeProvider } from '../src/components/ThemeProvider';
import '../src/app/globals.css';

const preview: Preview = {
  parameters: {
    layout: 'padded',
    backgrounds: { disable: true },
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
