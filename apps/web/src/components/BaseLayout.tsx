'use client';

import { usePathname } from 'next/navigation';
import { Footer } from './Footer';
import { ProgressLink } from './ProgressLink';
import { ToggleSwitch } from './ToggleSwitch';

interface BaseLayoutProps {
  children: React.ReactNode;
  showTypeHeader?: boolean;
  currentTab?: 'tech' | 'note' | 'who';
}

export function BaseLayout({ children, showTypeHeader = false, currentTab }: BaseLayoutProps) {
  const pathname = usePathname();

  // Use currentTab if provided, otherwise fall back to pathname
  const isTechActive =
    currentTab === 'tech' || (!currentTab && (pathname === '/' || pathname === undefined));
  const isNoteActive = currentTab === 'note' || (!currentTab && pathname === '/type/note');
  const isWhoActive = currentTab === 'who' || (!currentTab && pathname === '/who');
  // NOTE: doneProgress()はここで呼ばない
  // loading.tsxもBaseLayoutを使用するため、スケルトン表示時に完了してしまう
  // 各ページの末端コンポーネント（PageReady, ArticleContent等）で呼ぶ

  const tabActiveClass = 'border-b-2 pb-0.5 border-[var(--color-text)]';

  return (
    <div className="relative min-h-[110%]">
      {/* Header */}
      <div className="h-12 w-full bg-[var(--color-surface-raised)]">
        <div className="mx-auto flex max-w-[var(--layout-max)] items-center justify-between px-8 pt-3 pb-1 max-sm:px-4">
          <ProgressLink href="/">
            <div className="text-2xl font-bold">shuntaka.dev</div>
          </ProgressLink>
          <ToggleSwitch />
        </div>
      </div>

      {/* Type Header (tech/note/who?) */}
      {showTypeHeader && (
        <nav
          className="w-full bg-[var(--color-surface-raised)]"
          aria-label="カテゴリーナビゲーション"
        >
          <div className="mx-auto max-w-[var(--layout-max)] px-8 max-sm:px-4 max-sm:pt-3">
            <div className="inline-block mr-2">
              <ProgressLink href="/" className={isTechActive ? tabActiveClass : ''}>
                tech
              </ProgressLink>
            </div>
            <div className="inline-block mr-2">
              <ProgressLink href="/type/note" className={isNoteActive ? tabActiveClass : ''}>
                note
              </ProgressLink>
            </div>
            <div className="inline-block mr-2">
              <ProgressLink href="/who" className={isWhoActive ? tabActiveClass : ''}>
                who?
              </ProgressLink>
            </div>
          </div>
        </nav>
      )}

      {/* Page Body */}
      <div className="mx-auto max-w-[var(--layout-max)] px-8 pt-2 pb-[var(--layout-footer-h)] max-sm:px-4 max-sm:pt-3">
        {children}
      </div>

      {/* Footer */}
      <div className="absolute bottom-0 mx-auto w-full">
        <Footer />
      </div>
    </div>
  );
}
