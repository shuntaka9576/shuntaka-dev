export interface Article {
  articleId: string;
  title: string;
  slug: string;
  content: string;
  contentHtml?: string;
  description: string;
  type: string | null;
  thumbnail: string | null;
  ogpUrl: string;
  /** フルパス表記のタグ（例: "tech/rust", "tech/aws/lambda"） */
  tags: string[];
  publishedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ArticleSummary {
  articleId: string;
  title: string;
  slug: string;
  description: string;
  type: string | null;
  thumbnail: string | null;
  ogpUrl: string;
  /** フルパス表記のタグ（例: "tech/rust", "tech/aws/lambda"） */
  tags: string[];
  publishedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ArticlesPage {
  articles: ArticleSummary[];
  totalCount: number;
  page: number;
  perPage: number;
  totalPages: number;
}

export interface ArticlesQueryOptions {
  page?: number;
  perPage?: number | 'all';
}

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080';

export async function getArticlesByType(
  userName: string,
  type: 'tech' | 'note',
  opts: ArticlesQueryOptions = {},
): Promise<ArticlesPage> {
  const params = new URLSearchParams({ type });
  if (opts.page !== undefined) {
    params.set('page', String(opts.page));
  }
  if (opts.perPage !== undefined) {
    params.set('perPage', String(opts.perPage));
  }

  const res = await fetch(`${API_BASE_URL}/users/${userName}/articles?${params.toString()}`, {
    next: { revalidate: 30 },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch articles: ${res.status}`);
  }

  return res.json();
}

export async function getArticleBySlug(userName: string, slug: string): Promise<Article | null> {
  const res = await fetch(`${API_BASE_URL}/users/${userName}/articles/${slug}`, {
    next: { revalidate: 30 },
  });

  if (res.status === 404) {
    return null;
  }

  if (!res.ok) {
    throw new Error(`Failed to fetch article: ${res.status}`);
  }

  return res.json();
}
