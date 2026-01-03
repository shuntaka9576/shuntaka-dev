'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useNavigationProgress } from './NavigationProgressProvider';

type ProgressLinkProps = React.ComponentProps<typeof Link>;

export function ProgressLink({
  children,
  href,
  onClick,
  ...props
}: ProgressLinkProps) {
  const { startProgress } = useNavigationProgress();
  const pathname = usePathname();

  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    const targetPath = typeof href === 'string' ? href : href.pathname;
    if (targetPath !== pathname) {
      startProgress();
    }
    onClick?.(e);
  };

  return (
    <Link href={href} onClick={handleClick} {...props}>
      {children}
    </Link>
  );
}
