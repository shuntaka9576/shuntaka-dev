export interface Article {
  articleId: string;
  title: string;
  slug: string;
  content: string;
  contentHtml?: string;
  description: string;
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
  /** タグ絞り込み。フルパス（例: "tech/aws/lambda"）で指定する */
  tags?: string[];
  /** AND（デフォルト）または OR。API のデフォルトが AND のため OR 時のみ送信する */
  mode?: 'and' | 'or';
  /** true にすると ISR キャッシュを使わず常に最新を取得する（クライアントサイドフェッチ用） */
  noCache?: boolean;
  signal?: AbortSignal;
}

export interface TagFacet {
  path: string;
  count: number;
}

export interface TagFacetsResult {
  facets: TagFacet[];
}

export interface TagFacetsOptions {
  tags?: string[];
  mode?: 'and' | 'or';
  noCache?: boolean;
  signal?: AbortSignal;
}

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080';

/**
 * tags 配列を API 仕様に合わせてクエリ文字列部分に変換する。
 * 各タグ内の "/" を encodeURIComponent でエンコードし、タグ間の区切りはカンマ（生のまま）。
 * mode は API デフォルトが AND のため OR のときのみパラメータを付与する。
 */
function buildTagsQuery(tags: string[], mode?: 'and' | 'or'): string[] {
  const parts: string[] = [];
  if (tags.length > 0) {
    parts.push(`tags=${tags.map(encodeURIComponent).join(',')}`);
    if (mode === 'or') parts.push('mode=or');
  }
  return parts;
}

export async function getArticles(
  userName: string,
  opts: ArticlesQueryOptions = {},
): Promise<ArticlesPage> {
  const queryParts: string[] = [];
  if (opts.page !== undefined) queryParts.push(`page=${opts.page}`);
  if (opts.perPage !== undefined) queryParts.push(`perPage=${opts.perPage}`);
  if (opts.tags && opts.tags.length > 0) {
    queryParts.push(...buildTagsQuery(opts.tags, opts.mode));
  }

  const query = queryParts.length > 0 ? `?${queryParts.join('&')}` : '';
  const url = `${API_BASE_URL}/users/${userName}/articles${query}`;
  const fetchOpts = opts.noCache
    ? { cache: 'no-store' as const, signal: opts.signal }
    : { next: { revalidate: 30 }, signal: opts.signal };

  const res = await fetch(url, fetchOpts);

  if (!res.ok) {
    throw new Error(`Failed to fetch articles: ${res.status}`);
  }

  return res.json();
}

/**
 * tag-facets API を呼び出し、指定した絞り込み条件に対するタグファセット（タグ別記事数）を返す。
 * tags 省略時は全公開記事の集計（パネル初期表示・SSR 埋め込み用）。
 */
export async function getTagFacets(
  userName: string,
  opts: TagFacetsOptions = {},
): Promise<TagFacetsResult> {
  const queryParts: string[] = [];
  if (opts.tags && opts.tags.length > 0) {
    queryParts.push(...buildTagsQuery(opts.tags, opts.mode));
  }

  const query = queryParts.length > 0 ? `?${queryParts.join('&')}` : '';
  const url = `${API_BASE_URL}/users/${userName}/articles/tag-facets${query}`;
  const fetchOpts = opts.noCache
    ? { cache: 'no-store' as const, signal: opts.signal }
    : { next: { revalidate: 30 }, signal: opts.signal };

  const res = await fetch(url, fetchOpts);

  if (!res.ok) {
    throw new Error(`Failed to fetch tag facets: ${res.status}`);
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
