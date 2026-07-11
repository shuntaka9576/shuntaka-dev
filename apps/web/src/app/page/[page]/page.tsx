import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ArticleListView } from '@/components/ArticleListView';
import { getArticles } from '@/lib/api';
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
      canonical: `${SITE_URL}/page/${page}`,
    },
  };
}

export default async function PostsPaginationPage({ params }: PageProps) {
  const { page: rawPage } = await params;
  const page = parsePage(rawPage);
  if (page === null) notFound();

  // 範囲外ページ判定用の全件フェッチ。sitemap と同じ URL のため Next の fetch dedup が効く
  const probe = await getArticles(USER_NAME, { perPage: 'all' });
  if (probe.articles.length <= (page - 1) * ARTICLES_PER_PAGE) notFound();

  return <ArticleListView page={page} baseHref="/" />;
}
