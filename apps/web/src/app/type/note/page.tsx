import type { Metadata } from 'next';
import { ArticleListView } from '@/components/ArticleListView';
import { SITE_URL } from '@/lib/constants';

export const metadata: Metadata = {
  alternates: {
    canonical: `${SITE_URL}/type/note`,
  },
};

export default async function NotePage() {
  return <ArticleListView type="note" currentTab="note" page={1} baseHref="/type/note" />;
}
