import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ArticleListView } from '@/components/ArticleListView';
import { getArticlesByType } from '@/lib/api';
import { SITE_URL, USER_NAME } from '@/lib/constants';

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
      canonical: `${SITE_URL}/page/${page}`,
    },
  };
}

export default async function TechPaginationPage({ params }: PageProps) {
  const { page: rawPage } = await params;
  const page = parsePage(rawPage);
  if (page === null) notFound();

  const probe = await getArticlesByType(USER_NAME, 'tech', { page, perPage: 10 });
  if (probe.articles.length === 0) notFound();

  return <ArticleListView type="tech" currentTab="tech" page={page} baseHref="/" />;
}
