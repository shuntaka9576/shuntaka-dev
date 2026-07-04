import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ArticleListView } from '@/components/ArticleListView';
import { getArticlesByType } from '@/lib/api';
import { ARTICLES_PER_PAGE, SITE_URL, USER_NAME } from '@/lib/constants';

interface PageProps {
  params: Promise<{ page: string }>;
}

function parsePage(raw: string): number | null {
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 2 ? n : null;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { page: rawPage } = await params;
  const page = parsePage(rawPage);
  if (page === null) return {};
  return {
    alternates: {
      canonical: `${SITE_URL}/type/note/page/${page}`,
    },
  };
}

export default async function NotePaginationPage({ params }: PageProps) {
  const { page: rawPage } = await params;
  const page = parsePage(rawPage);
  if (page === null) notFound();

  // ArticleListView と同じ perPage=all フェッチにして Next の fetch dedup を効かせる
  const probe = await getArticlesByType(USER_NAME, 'note', { perPage: 'all' });
  if (probe.articles.length <= (page - 1) * ARTICLES_PER_PAGE) notFound();

  return <ArticleListView type="note" currentTab="note" page={page} baseHref="/type/note" />;
}
