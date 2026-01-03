'use client';

import type React from 'react';
import { createContext, useContext, useEffect, useState } from 'react';

type ColorTheme = {
  colorMode?: string;
  changeColorMode: (cm: string) => void;
};

const ColorThemeContext = createContext<ColorTheme>({
  changeColorMode: () => {},
});

export function useColorTheme() {
  return useContext(ColorThemeContext);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [colorMode, setColorMode] = useState<string | undefined>(undefined);

  useEffect(() => {
    const saved = window.localStorage.getItem('color-mode');
    if (saved) {
      document.documentElement.dataset.theme = saved;
      setColorMode(saved);
    } else {
      const prefersDark = window.matchMedia(
        '(prefers-color-scheme: dark)'
      ).matches;
      const theme = prefersDark ? 'dark' : 'light';
      document.documentElement.dataset.theme = theme;
      setColorMode(theme);
    }
  }, []);

  const changeColorMode = (mode: string) => {
    document.documentElement.dataset.theme = mode;
    setColorMode(mode);
    window.localStorage.setItem('color-mode', mode);
  };

  return (
    <ColorThemeContext.Provider value={{ colorMode, changeColorMode }}>
      {children}
    </ColorThemeContext.Provider>
  );
}
