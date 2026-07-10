'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useRef } from 'react';
import { useNavigationProgress } from './NavigationProgressProvider';

type ProgressLinkProps = React.ComponentProps<typeof Link>;

export function ProgressLink({
  children,
  href,
  onClick,
  onMouseEnter,
  onTouchStart,
  prefetch = false,
  ...props
}: ProgressLinkProps) {
  const { startProgress } = useNavigationProgress();
  const pathname = usePathname();
  const router = useRouter();
  const prefetchCalledRef = useRef(false);

  // router.prefetch は string のみ受け付けるため UrlObject を正規化する
  const hrefString = typeof href === 'string' ? href : (href.pathname ?? '/');

  // viewport prefetch の一斉発火を避け、hover / touch の意図があった時だけ単発で prefetch する。
  // App Router では prefetch={false} だと hover でも自動 prefetch されないため手動で呼ぶ
  const triggerPrefetch = useCallback(() => {
    if (prefetch !== false) return;
    if (prefetchCalledRef.current) return;
    prefetchCalledRef.current = true;
    router.prefetch(hrefString);
  }, [router, hrefString, prefetch]);

  const handleMouseEnter = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>) => {
      triggerPrefetch();
      onMouseEnter?.(e);
    },
    [triggerPrefetch, onMouseEnter],
  );

  const handleTouchStart = useCallback(
    (e: React.TouchEvent<HTMLAnchorElement>) => {
      triggerPrefetch();
      onTouchStart?.(e);
    },
    [triggerPrefetch, onTouchStart],
  );

  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);

    // 修飾キー / 中クリック / target="_blank" 等は現在のタブが遷移せず
    // 別タブ・別ウィンドウで開くため、startProgress() を呼ぶとバーが完了せず残る。
    // 同一タブでのクライアント遷移が実際に起きるクリックのときだけ開始する
    const targetAttr = e.currentTarget.target;
    if (
      e.defaultPrevented ||
      e.button !== 0 ||
      e.metaKey ||
      e.ctrlKey ||
      e.shiftKey ||
      e.altKey ||
      (targetAttr && targetAttr !== '_self')
    ) {
      return;
    }

    const targetPath = typeof href === 'string' ? href : href.pathname;
    if (targetPath !== pathname) {
      startProgress();
    }
  };

  return (
    <Link
      href={href}
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
      onTouchStart={handleTouchStart}
      prefetch={prefetch}
      {...props}
    >
      {children}
    </Link>
  );
}
