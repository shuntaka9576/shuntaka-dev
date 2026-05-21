'use client';

import type React from 'react';
import { createContext, useContext, useState } from 'react';

type ColorMode = 'light' | 'dark';

type ColorTheme = {
  colorMode: ColorMode;
  changeColorMode: (cm: ColorMode) => void;
};

const ColorThemeContext = createContext<ColorTheme>({
  colorMode: 'light',
  changeColorMode: () => {},
});

export function useColorTheme() {
  return useContext(ColorThemeContext);
}

function readInitialColorMode(): ColorMode {
  if (typeof document === 'undefined') return 'light';
  const fromDom = document.documentElement.dataset.theme;
  if (fromDom === 'dark' || fromDom === 'light') return fromDom;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [colorMode, setColorMode] = useState<ColorMode>(readInitialColorMode);

  const changeColorMode = (mode: ColorMode) => {
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
