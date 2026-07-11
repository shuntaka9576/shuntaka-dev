import type { Metadata } from 'next';
import { ArticleListView } from '@/components/ArticleListView';
import { SITE_URL } from '@/lib/constants';

export const metadata: Metadata = {
  alternates: {
    canonical: `${SITE_URL}/`,
  },
};

export default async function Home() {
  return <ArticleListView page={1} baseHref="/" />;
}
