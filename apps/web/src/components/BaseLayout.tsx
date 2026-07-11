'use client';

import { usePathname } from 'next/navigation';
import { Footer } from './Footer';
import { ProgressLink } from './ProgressLink';
import { ToggleSwitch } from './ToggleSwitch';

interface BaseLayoutProps {
  children: React.ReactNode;
  showTypeHeader?: boolean;
  currentTab?: 'posts' | 'about';
  /** ヘッダー・タブ行・本文を記事一覧と同じ --layout-list-max のカラムに揃える */
  narrow?: boolean;
}

export function BaseLayout({
  children,
  showTypeHeader = false,
  currentTab,
  narrow = false,
}: BaseLayoutProps) {
  const pathname = usePathname();

  // Use currentTab if provided, otherwise fall back to pathname
  const isPostsActive =
    currentTab === 'posts' || (!currentTab && (pathname === '/' || pathname === undefined));
  const isAboutActive = currentTab === 'about' || (!currentTab && pathname === '/about');
  // NOTE: doneProgress()はここで呼ばない
  // loading.tsxもBaseLayoutを使用するため、スケルトン表示時に完了してしまう
  // 各ページの末端コンポーネント（PageReady, ArticleContent等）で呼ぶ

  const tabActiveClass = 'border-b-2 pb-0.5 border-[var(--color-text)]';
  // narrow 時はコンテンツ幅 600px + 左右 px-8 ぶんを確保し、一覧カラムと左端を揃える
  const widthClass = narrow
    ? 'max-w-[calc(var(--layout-list-max)+4rem)]'
    : 'max-w-[var(--layout-max)]';

  return (
    <div className="relative min-h-full">
      {/* Header */}
      <div className="h-12 w-full bg-[var(--color-surface-raised)]">
        <div
          className={`mx-auto flex items-center justify-between px-8 pt-3 pb-1 max-sm:px-4 ${widthClass}`}
        >
          <ProgressLink href="/">
            <div className="text-2xl font-semibold">shuntaka.dev</div>
          </ProgressLink>
          <ToggleSwitch />
        </div>
      </div>

      {/* Type Header (posts/about) */}
      {showTypeHeader && (
        <nav
          className="sticky top-0 z-10 w-full border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)]"
          aria-label="カテゴリーナビゲーション"
        >
          <div className={`mx-auto flex items-baseline px-8 max-sm:px-4 max-sm:pt-3 ${widthClass}`}>
            <div>
              <div className="inline-block mr-2">
                <ProgressLink href="/" className={isPostsActive ? tabActiveClass : ''}>
                  posts
                </ProgressLink>
              </div>
              <div className="inline-block mr-2">
                <ProgressLink href="/about" className={isAboutActive ? tabActiveClass : ''}>
                  about
                </ProgressLink>
              </div>
            </div>
          </div>
        </nav>
      )}

      {/* Page Body */}
      <div
        className={`mx-auto px-8 pt-2 pb-[var(--layout-footer-h)] max-sm:px-4 max-sm:pt-3 ${widthClass}`}
      >
        {children}
      </div>

      {/* Footer */}
      <div className="absolute bottom-0 mx-auto w-full">
        <Footer />
      </div>
    </div>
  );
}
