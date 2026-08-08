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

/** セマンティック検索のヒット記事。既存 ArticleSummary に距離を足したもの。 */
export interface SearchArticleResult extends ArticleSummary {
  /** cosine distance (0..2)。API 側の `distance` フィールドを 1:1 で写す */
  distance: number;
}

export interface SearchArticlesResult {
  articles: SearchArticleResult[];
  /** サーバがエコーする検索語 */
  query: string;
  /** サーバに渡された上限件数 */
  limit: number;
  /** サーバに渡されたオフセット */
  offset: number;
  /**
   * スコープ内の全マッチ記事数（タグ併用時: ファセット件数と一致する真値 /
   * 検索のみ: 固定候補窓内のユニーク記事数）。offset に依存せず安定するため
   * ページネーションの分母に使える
   */
  totalCount: number;
}

export interface SearchArticlesOptions {
  /** タグ絞り込み。フルパス（例: "tech/rust"）で指定する */
  tags?: string[];
  /** AND（デフォルト）または OR。API のデフォルトが AND のため OR 時のみ送信する */
  mode?: 'and' | 'or';
  /** 上限件数。省略時は API のデフォルト（20）に従う */
  limit?: number;
  /** オフセット（ページネーション用）。省略時は 0 */
  offset?: number;
  signal?: AbortSignal;
}

/** 写真の留め具（壁に貼るイメージ）。投稿時に管理画面で選ぶ */
export type MomentFastener = 'clip' | 'tape';

/** 留め具の色（tape のみ有効）。未指定は半透明グレー */
export type MomentFastenerColor = 'pink' | 'blue' | 'yellow' | 'green';

/** moment（180 文字以内の一文 + 写真必須の投稿）1 件分のサマリ */
export interface MomentSummary {
  momentId: string;
  /** 180 文字以内の一文 */
  text: string;
  /** orig 画像の URL（images.<fqdn> 配信） */
  imageUrl: string;
  /** 一覧表示用サムネイルの URL（長辺 640px） */
  thumbUrl: string;
  /** 撮影時刻（EXIF 由来。TZ なしのローカル日時 YYYY-MM-DDTHH:mm:ss。壁時計のまま表示する） */
  capturedAt: string;
  /** 未指定は clip */
  fastener?: MomentFastener;
  /** tape のみ有効。clip は木の色固定 */
  fastenerColor?: MomentFastenerColor | null;
}

export interface MomentsPage {
  moments: MomentSummary[];
  /** 次ページ取得用カーソル。null で末尾 */
  nextCursor: string | null;
}

export interface MomentsQueryOptions {
  cursor?: string;
  limit?: number;
  /** true にすると ISR キャッシュを使わず常に最新を取得する（クライアントサイドフェッチ用） */
  noCache?: boolean;
  signal?: AbortSignal;
}

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:43003';

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
    : { signal: opts.signal };

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
    : { signal: opts.signal };

  const res = await fetch(url, fetchOpts);

  if (!res.ok) {
    throw new Error(`Failed to fetch tag facets: ${res.status}`);
  }

  return res.json();
}

/**
 * `/users/{userName}/articles/search` を呼び出し、セマンティック検索結果を返す。
 * `q` が空文字のとき呼び出しは想定しない（呼び出し側でガードする）。
 * タグと mode 併用時も同じ endpoint に query として付与する。
 */
export async function searchArticles(
  userName: string,
  q: string,
  opts: SearchArticlesOptions = {},
): Promise<SearchArticlesResult> {
  const queryParts: string[] = [`q=${encodeURIComponent(q)}`];
  if (opts.limit !== undefined) queryParts.push(`limit=${opts.limit}`);
  if (opts.offset !== undefined && opts.offset > 0) queryParts.push(`offset=${opts.offset}`);
  if (opts.tags && opts.tags.length > 0) {
    queryParts.push(...buildTagsQuery(opts.tags, opts.mode));
  }

  const url = `${API_BASE_URL}/users/${userName}/articles/search?${queryParts.join('&')}`;
  const res = await fetch(url, { cache: 'no-store', signal: opts.signal });

  if (!res.ok) {
    throw new Error(`Failed to search articles: ${res.status}`);
  }

  return res.json();
}

/**
 * 公開 moments を新しい順に取得する（カーソルページング）。
 * 初回は cursor なし、以降はレスポンスの nextCursor を渡して継ぎ足す。
 */
export async function getMoments(
  userName: string,
  opts: MomentsQueryOptions = {},
): Promise<MomentsPage> {
  const queryParts: string[] = [];
  if (opts.cursor !== undefined) queryParts.push(`cursor=${encodeURIComponent(opts.cursor)}`);
  if (opts.limit !== undefined) queryParts.push(`limit=${opts.limit}`);

  const query = queryParts.length > 0 ? `?${queryParts.join('&')}` : '';
  const url = `${API_BASE_URL}/users/${userName}/moments${query}`;
  const fetchOpts = opts.noCache
    ? { cache: 'no-store' as const, signal: opts.signal }
    : { signal: opts.signal };

  const res = await fetch(url, fetchOpts);

  if (!res.ok) {
    throw new Error(`Failed to fetch moments: ${res.status}`);
  }

  return res.json();
}

export async function getArticleBySlug(userName: string, slug: string): Promise<Article | null> {
  const res = await fetch(`${API_BASE_URL}/users/${userName}/articles/${slug}`);

  if (res.status === 404) {
    return null;
  }

  if (!res.ok) {
    throw new Error(`Failed to fetch article: ${res.status}`);
  }

  return res.json();
}
