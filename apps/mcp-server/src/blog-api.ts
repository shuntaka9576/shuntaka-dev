// blog-api (apps/blog-api) の公開 API を呼ぶクライアント。公開済み記事しか返さない API だけを使うため、
// 認証あり・なしのどちらの MCP エンドポイントから呼んでも見えるデータは同じ

export type TagMode = 'and' | 'or';

export interface ArticleSummary {
  articleId: string;
  title: string;
  slug: string;
  description: string;
  thumbnail: string | null;
  ogpUrl: string;
  tags: string[];
  publishedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface Article extends ArticleSummary {
  content: string;
  contentHtml: string;
}

export interface ArticleList {
  articles: ArticleSummary[];
  totalCount: number;
  page: number;
  perPage: number;
  totalPages: number;
}

export interface ArticleSearchResult {
  articles: (ArticleSummary & { distance: number })[];
  query: string;
  limit: number;
  offset: number;
  totalCount: number;
}

export interface TagFacets {
  facets: { path: string; count: number }[];
}

export class BlogApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'BlogApiError';
  }
}

export interface BlogApiClientOptions {
  /** 例: https://shuntaka.dev/api */
  baseUrl: string;
  userName: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class BlogApiClient {
  private readonly fetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: BlogApiClientOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  listArticles(params: {
    page?: number;
    perPage?: number;
    tags?: string[];
    mode?: TagMode;
  }): Promise<ArticleList> {
    return this.get<ArticleList>('/articles', {
      page: params.page,
      perPage: params.perPage,
      tags: params.tags?.join(','),
      mode: params.mode,
    });
  }

  searchArticles(params: {
    query: string;
    tags?: string[];
    mode?: TagMode;
    limit?: number;
    offset?: number;
  }): Promise<ArticleSearchResult> {
    return this.get<ArticleSearchResult>('/articles/search', {
      q: params.query,
      tags: params.tags?.join(','),
      mode: params.mode,
      limit: params.limit,
      offset: params.offset,
    });
  }

  listTagFacets(params: { tags?: string[]; mode?: TagMode }): Promise<TagFacets> {
    return this.get<TagFacets>('/articles/tag-facets', {
      tags: params.tags?.join(','),
      mode: params.mode,
    });
  }

  /** 存在しない (または非公開の) slug は null を返す */
  async getArticle(slug: string): Promise<Article | null> {
    try {
      return await this.get<Article>(`/articles/${encodeURIComponent(slug)}`, {});
    } catch (error) {
      if (error instanceof BlogApiError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  private async get<T>(
    path: string,
    query: Record<string, string | number | undefined>,
  ): Promise<T> {
    // URLSearchParams は空白を `+` にするが、CloudFront OAC 経由の Web Function は `+` を含むクエリを
    // 署名不一致の 403 にする (`%20` なら通る)。encodeURIComponent で `%20` にする
    const search = Object.entries(query)
      .filter(([, value]) => value !== undefined && value !== '')
      .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
      .join('&');
    const url = `${this.options.baseUrl}/users/${encodeURIComponent(this.options.userName)}${path}${search ? `?${search}` : ''}`;
    const response = await this.fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      // blog-api のエラーは { error, message } を返す。それ以外 (CloudFront などの HTML) は本文を返さない
      const body = (await response.json().catch(() => null)) as { message?: unknown } | null;
      const detail = typeof body?.message === 'string' ? body.message : response.statusText;
      throw new BlogApiError(response.status, `blog-api ${response.status}: ${detail}`);
    }
    return (await response.json()) as T;
  }
}
