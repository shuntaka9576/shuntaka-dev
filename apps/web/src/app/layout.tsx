import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Analytics } from '@vercel/analytics/next';
import { SpeedInsights } from '@vercel/speed-insights/next';
import { Clarity } from '@/components/Clarity';
import { GoogleTagManager } from '@/components/GoogleTagManager';
import { GoogleTagManagerNoscript } from '@/components/GoogleTagManagerNoscript';
import { NavigationProgressProvider } from '@/components/NavigationProgressProvider';
import { ThemeProvider } from '@/components/ThemeProvider';
import { SITE_DESCRIPTION, SITE_TITLE, SITE_URL } from '@/lib/constants';

const GEN_INTERFACE_JP_VERSION = '0.1.7';
const GEN_INTERFACE_JP_BASE = `https://cdn.jsdelivr.net/npm/gen-interface-jp@${GEN_INTERFACE_JP_VERSION}`;

const OG_IMAGE_URL =
  'https://res.cloudinary.com/dkerzyk09/image/upload/v1767101809/blog/og/shuntaka.png';

const COLOR_SCHEME_BOOT_SCRIPT = `(function(){try{var s=localStorage.getItem('color-mode');var t=s==='dark'||s==='light'?s:(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');document.documentElement.dataset.theme=t;}catch(e){}})();`;

export const viewport: Viewport = {
  colorScheme: 'light dark',
};

export const metadata: Metadata = {
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  metadataBase: new URL(SITE_URL),
  alternates: {
    canonical: '/',
    types: {
      'application/rss+xml': '/feed',
    },
  },
  icons: {
    icon: '/icons/icon.png',
    apple: '/icons/apple-icon.png',
  },
  openGraph: {
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    url: SITE_URL,
    siteName: SITE_TITLE,
    images: [
      {
        url: OG_IMAGE_URL,
      },
    ],
    locale: 'ja_JP',
    type: 'website',
  },
  twitter: {
    card: 'summary',
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: [OG_IMAGE_URL],
    creator: '@shuntaka_jp',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja" suppressHydrationWarning>
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: inline boot script must run synchronously before paint to prevent theme FOUC */}
        <script dangerouslySetInnerHTML={{ __html: COLOR_SCHEME_BOOT_SCRIPT }} />
      </head>
      <GoogleTagManager />
      <link rel="preconnect" href="https://cdn.jsdelivr.net" crossOrigin="anonymous" />
      <link rel="stylesheet" href={`${GEN_INTERFACE_JP_BASE}/300.css`} precedence="default" />
      <link rel="stylesheet" href={`${GEN_INTERFACE_JP_BASE}/400.css`} precedence="default" />
      <link rel="stylesheet" href={`${GEN_INTERFACE_JP_BASE}/500.css`} precedence="default" />
      <link rel="stylesheet" href={`${GEN_INTERFACE_JP_BASE}/600.css`} precedence="default" />
      <link rel="stylesheet" href={`${GEN_INTERFACE_JP_BASE}/700.css`} precedence="default" />
      <body>
        <GoogleTagManagerNoscript />
        <ThemeProvider>
          <NavigationProgressProvider>{children}</NavigationProgressProvider>
        </ThemeProvider>
        <SpeedInsights />
        <Analytics />
        <Clarity />
      </body>
    </html>
  );
}
