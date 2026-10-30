import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { type ArticleSummary, BlogApiError, type BlogApiClient } from './blog-api.js';

export interface BlogMcpOptions {
  blogApi: BlogApiClient;
  /** 記事ページの URL を組み立てるための公開サイトの URL (例: https://shuntaka.dev) */
  siteUrl: string;
  userName: string;
  /** ツール呼び出しごとに 1 行ログを出す。認証あり・なしのどちらから呼ばれたかを残す */
  onToolCall?: (record: ToolCallRecord) => void;
  /** ログに載せる接続経路 */
  endpoint: 'public' | 'auth';
}

export interface ToolCallRecord {
  tool: string;
  endpoint: 'public' | 'auth';
  ok: boolean;
  durationMs: number;
  error?: string;
}

const INSTRUCTIONS = [
  'Tools for reading shuntaka.dev, a Japanese tech blog by shuntaka (AWS, Rust, TypeScript, and personal projects).',
  'All tools are read-only and only return published articles.',
  'Use search_articles for natural-language questions, list_articles to browse by recency or tag, list_tags to discover tag paths, and get_article to read the full Markdown of one article.',
  'Cite articles with the returned url.',
].join(' ');

// タグはフルパス表記 (例: "tech/aws/lambda")。親タグを指定すると子タグの記事も含まれる
const tagsSchema = z
  .array(z.string().min(1).max(100))
  .max(10)
  .optional()
  .describe(
    'Full-path tags to filter by, e.g. ["tech/aws/lambda"]. A parent tag also matches its descendants. Use list_tags to find valid paths.',
  );
const tagModeSchema = z
  .enum(['and', 'or'])
  .optional()
  .describe('How multiple tags combine: "and" (default, all must match) or "or" (any matches).');

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  // 返すのはこのブログの記事だけで、外部への書き込みや任意 URL の取得はしない
  openWorldHint: false,
} as const;

export const createBlogMcpServer = (options: BlogMcpOptions): McpServer => {
  const { blogApi } = options;
  const articleUrl = (slug: string) => `${options.siteUrl}/${options.userName}/articles/${slug}`;
  const summarize = (article: ArticleSummary) => ({
    title: article.title,
    slug: article.slug,
    url: articleUrl(article.slug),
    description: article.description,
    tags: article.tags,
    publishedAt: article.publishedAt,
    updatedAt: article.updatedAt,
  });

  // 呼び出し結果を JSON テキストと structuredContent の両方で返し、失敗は isError で返す
  const run = async (tool: string, body: () => Promise<object>): Promise<CallToolResult> => {
    const startedAt = Date.now();
    try {
      const result = await body();
      options.onToolCall?.({
        tool,
        endpoint: options.endpoint,
        ok: true,
        durationMs: Date.now() - startedAt,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result as Record<string, unknown>,
      };
    } catch (error) {
      const message =
        error instanceof BlogApiError && error.status < 500
          ? error.message
          : 'The blog API is temporarily unavailable. Try again later.';
      options.onToolCall?.({
        tool,
        endpoint: options.endpoint,
        ok: false,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      return { content: [{ type: 'text', text: message }], isError: true };
    }
  };

  const server = new McpServer(
    {
      name: 'shuntaka-dev-blog',
      title: 'shuntaka.dev blog',
      version: '1.0.0',
      websiteUrl: options.siteUrl,
    },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    'search_articles',
    {
      title: 'Search articles',
      description:
        'Semantic search over published articles. Accepts natural-language queries in Japanese or English and returns the closest matches first, with a cosine distance (smaller is closer).',
      inputSchema: z.object({
        query: z.string().trim().min(1).max(500).describe('What to look for, in natural language.'),
        tags: tagsSchema,
        tag_mode: tagModeSchema,
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('Results per page (default 10).'),
        offset: z.number().int().min(0).max(1000).optional().describe('Number of results to skip.'),
      }),
      annotations: { title: 'Search articles', ...READ_ONLY },
    },
    ({ query, tags, tag_mode, limit, offset }) =>
      run('search_articles', async () => {
        const result = await blogApi.searchArticles({
          query,
          tags,
          mode: tag_mode,
          limit: limit ?? 10,
          offset,
        });
        return {
          query: result.query,
          totalCount: result.totalCount,
          offset: result.offset,
          articles: result.articles.map((article) => ({
            ...summarize(article),
            distance: article.distance,
          })),
        };
      }),
  );

  server.registerTool(
    'list_articles',
    {
      title: 'List articles',
      description:
        'List published articles, newest first, optionally filtered by tags. Use it to browse recent posts or every post under a topic.',
      inputSchema: z.object({
        tags: tagsSchema,
        tag_mode: tagModeSchema,
        page: z.number().int().min(1).optional().describe('1-based page number (default 1).'),
        per_page: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('Articles per page (default 20).'),
      }),
      annotations: { title: 'List articles', ...READ_ONLY },
    },
    ({ tags, tag_mode, page, per_page }) =>
      run('list_articles', async () => {
        const result = await blogApi.listArticles({
          tags,
          mode: tag_mode,
          page,
          perPage: per_page ?? 20,
        });
        return {
          totalCount: result.totalCount,
          page: result.page,
          totalPages: result.totalPages,
          articles: result.articles.map(summarize),
        };
      }),
  );

  server.registerTool(
    'get_article',
    {
      title: 'Get article',
      description:
        'Get one published article by slug, including its full Markdown body. Slugs come from search_articles or list_articles.',
      inputSchema: z.object({
        slug: z
          .string()
          .min(1)
          .max(200)
          .describe('Article slug, e.g. the last path segment of the article URL.'),
      }),
      annotations: { title: 'Get article', ...READ_ONLY },
    },
    ({ slug }) =>
      run('get_article', async () => {
        const article = await blogApi.getArticle(slug);
        if (article === null) {
          throw new BlogApiError(404, `No published article has the slug "${slug}".`);
        }
        return { ...summarize(article), content: article.content };
      }),
  );

  server.registerTool(
    'list_tags',
    {
      title: 'List tags',
      description:
        'List tag paths with the number of published articles under each (descendant tags included), most used first. Pass tags to count only within articles that already match them.',
      inputSchema: z.object({ tags: tagsSchema, tag_mode: tagModeSchema }),
      annotations: { title: 'List tags', ...READ_ONLY },
    },
    ({ tags, tag_mode }) =>
      run('list_tags', async () => {
        const result = await blogApi.listTagFacets({ tags, mode: tag_mode });
        return { tags: result.facets };
      }),
  );

  return server;
};
