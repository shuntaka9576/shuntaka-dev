'use client';

import { usePathname } from 'next/navigation';
import { Footer } from './Footer';
import { ProgressLink } from './ProgressLink';
import { ToggleSwitch } from './ToggleSwitch';

interface BaseLayoutProps {
  children: React.ReactNode;
  showTypeHeader?: boolean;
}

export function BaseLayout({
  children,
  showTypeHeader = false,
}: BaseLayoutProps) {
  const pathname = usePathname();
  // NOTE: doneProgress()はここで呼ばない
  // loading.tsxもBaseLayoutを使用するため、スケルトン表示時に完了してしまう
  // 各ページの末端コンポーネント（PageReady, ArticleContent等）で呼ぶ

  return (
    <div className="relative min-h-[110%]">
      {/* Header */}
      <div
        className="h-12 w-full"
        style={{ background: 'var(--header-color)' }}
      >
        <div className="mx-auto flex max-w-[1200px] items-center justify-between px-8 pt-3 pb-1 max-sm:px-[2%]">
          <ProgressLink href="/">
            <div className="text-2xl font-bold">shuntaka.dev</div>
          </ProgressLink>
          <ToggleSwitch />
        </div>
      </div>

      {/* Type Header (tech/note/who?) */}
      {showTypeHeader && (
        <nav
          className="w-full"
          style={{ background: 'var(--header-color)' }}
          aria-label="カテゴリーナビゲーション"
        >
          <div className="mx-auto max-w-[1200px] px-8 max-sm:px-[2%] max-sm:pt-3">
            <div className="inline-block mr-2">
              <ProgressLink
                href="/"
                className={
                  pathname === '/' || pathname === undefined
                    ? 'border-b-2 pb-0.5'
                    : ''
                }
                style={
                  pathname === '/' || pathname === undefined
                    ? { borderColor: 'var(--text-color)' }
                    : {}
                }
              >
                tech
              </ProgressLink>
            </div>
            <div className="inline-block mr-2">
              <ProgressLink
                href="/type/note"
                className={pathname === '/type/note' ? 'border-b-2 pb-0.5' : ''}
                style={
                  pathname === '/type/note'
                    ? { borderColor: 'var(--text-color)' }
                    : {}
                }
              >
                note
              </ProgressLink>
            </div>
            <div className="inline-block mr-2">
              <ProgressLink
                href="/who"
                className={pathname === '/who' ? 'border-b-2 pb-0.5' : ''}
                style={
                  pathname === '/who'
                    ? { borderColor: 'var(--text-color)' }
                    : {}
                }
              >
                who?
              </ProgressLink>
            </div>
          </div>
        </nav>
      )}

      {/* Page Body */}
      <div className="mx-auto max-w-[1200px] px-8 pt-2 pb-[58px] max-sm:px-[2%] max-sm:pt-3">
        {children}
      </div>

      {/* Footer */}
      <div className="absolute bottom-0 mx-auto w-full">
        <Footer />
      </div>
    </div>
  );
}
