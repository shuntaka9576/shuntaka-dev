'use client';

import { useColorTheme } from './ThemeProvider';

export function ToggleSwitch() {
  const { colorMode, changeColorMode } = useColorTheme();

  const handleClick = () => {
    changeColorMode(colorMode === 'dark' ? 'light' : 'dark');
  };

  const isDark = colorMode === 'dark';

  return (
    <button
      type="button"
      className="toggle-switch"
      onClick={handleClick}
      aria-label={isDark ? 'ライトモードに切り替え' : 'ダークモードに切り替え'}
      aria-pressed={isDark}
      suppressHydrationWarning
    >
      <div className="toggle-label">
        <span className="dark-icon">
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="12" fill="#525457" />
            <path
              fillRule="evenodd"
              clipRule="evenodd"
              d="M5.15796 15.814C8.38588 16.544 11.796 15.174 13.4443 12.2218C15.0926 9.2696 14.4696 5.64776 12.1545 3.28291C12.8809 3.4472 13.5981 3.71786 14.284 4.10079C18.0173 6.18519 19.4067 10.8068 17.3875 14.4234C15.3682 18.04 10.7049 19.2821 6.97158 17.1977C6.28574 16.8148 5.679 16.3462 5.15796 15.814Z"
              fill="#FFF33F"
            />
          </svg>
        </span>
      </div>
    </button>
  );
}
