import type { Metadata } from 'next';
import { Noto_Sans_JP, Roboto } from 'next/font/google';
import './globals.css';
import { Analytics } from '@vercel/analytics/next';
import { SpeedInsights } from '@vercel/speed-insights/next';
import { GoogleTagManager } from '@/components/GoogleTagManager';
import { GoogleTagManagerNoscript } from '@/components/GoogleTagManagerNoscript';
import { NavigationProgressProvider } from '@/components/NavigationProgressProvider';
import { ThemeProvider } from '@/components/ThemeProvider';
import { SITE_DESCRIPTION, SITE_TITLE, SITE_URL } from '@/lib/constants';

const roboto = Roboto({
  subsets: ['latin'],
  weight: ['400', '700'],
  display: 'swap',
  variable: '--font-roboto',
});

const notoSansJP = Noto_Sans_JP({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-noto-sans-jp',
});

const OG_IMAGE_URL = `${SITE_URL}/images/og/hashi-light.png`;

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
    <html
      lang="ja"
      className={`${roboto.variable} ${notoSansJP.variable}`}
      suppressHydrationWarning
    >
      <GoogleTagManager />
      <body>
        <GoogleTagManagerNoscript />
        <ThemeProvider>
          <NavigationProgressProvider>{children}</NavigationProgressProvider>
        </ThemeProvider>
        <SpeedInsights />
        <Analytics />
      </body>
    </html>
  );
}
