import { describe, expect, it } from 'bun:test';
import { createApp } from './app.js';
import { createFakeBlogApi, mcpRequest, readMcpResponse } from './test-helpers.js';

const createPublicApp = () => {
  const blogApi = createFakeBlogApi();
  const logs: Record<string, unknown>[] = [];
  const app = createApp({
    baseUrl: 'https://mcp.example.com',
    blogApi: blogApi.client,
    siteUrl: 'https://example.com',
    userName: 'shuntaka',
    log: (record) => logs.push(record),
  });
  return { app, blogApi, logs };
};

describe('認証なしの /mcp', () => {
  it('initialize に応答する', async () => {
    const { app } = createPublicApp();
    const response = await mcpRequest(app, '/mcp', {
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    });
    expect(response.status).toBe(200);
    const body = await readMcpResponse(response);
    expect(body.result.serverInfo.name).toBe('shuntaka-dev-blog');
    expect(body.result.instructions).toContain('read-only');
  });

  it('4 つの読み取り専用ツールを公開する', async () => {
    const { app } = createPublicApp();
    const response = await mcpRequest(app, '/mcp', { method: 'tools/list' });
    const body = await readMcpResponse(response);
    const tools = body.result.tools as { name: string; annotations: Record<string, unknown> }[];
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'get_article',
      'list_articles',
      'list_tags',
      'search_articles',
    ]);
    for (const tool of tools) {
      expect(tool.annotations.readOnlyHint).toBe(true);
      expect(tool.annotations.destructiveHint).toBe(false);
    }
  });

  it('search_articles は blog-api の検索を呼び、記事の URL を付けて返す', async () => {
    const { app, blogApi, logs } = createPublicApp();
    const response = await mcpRequest(app, '/mcp', {
      method: 'tools/call',
      params: {
        name: 'search_articles',
        arguments: { query: 'Lambda の検証', tags: ['tech/aws'], tag_mode: 'or' },
      },
    });
    const body = await readMcpResponse(response);
    expect(body.result.isError).toBeUndefined();
    expect(body.result.structuredContent.articles[0]).toMatchObject({
      slug: 'lambda-web-functions',
      url: 'https://example.com/shuntaka/articles/lambda-web-functions',
      distance: 0.12,
    });
    const searched = blogApi.requests[0];
    expect(searched?.pathname).toBe('/api/users/shuntaka/articles/search');
    expect(searched?.searchParams.get('q')).toBe('Lambda の検証');
    expect(searched?.searchParams.get('tags')).toBe('tech/aws');
    expect(searched?.searchParams.get('mode')).toBe('or');
    expect(searched?.searchParams.get('limit')).toBe('10');
    // CloudFront OAC 経由の blog-api は `+` を含むクエリを 403 にするため、空白は %20 で送る
    expect(blogApi.rawUrls[0]).toContain('q=Lambda%20');
    expect(blogApi.rawUrls[0]).not.toContain('+');
    expect(blogApi.rawUrls[0]).toContain('tags=tech%2Faws');
    expect(logs).toContainEqual(
      expect.objectContaining({ type: 'mcp.tool', tool: 'search_articles', endpoint: 'public' }),
    );
  });

  it('get_article は Markdown の本文を返し、無い slug は isError にする', async () => {
    const { app } = createPublicApp();
    const found = await mcpRequest(app, '/mcp', {
      method: 'tools/call',
      params: { name: 'get_article', arguments: { slug: 'lambda-web-functions' } },
    });
    expect((await readMcpResponse(found)).result.structuredContent.content).toBe('# 本文');

    const missing = await mcpRequest(app, '/mcp', {
      method: 'tools/call',
      params: { name: 'get_article', arguments: { slug: 'missing' } },
    });
    const body = await readMcpResponse(missing);
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('missing');
  });

  it('レスポンスを CloudFront にキャッシュさせない', async () => {
    const { app } = createPublicApp();
    const response = await mcpRequest(app, '/mcp', { method: 'tools/list' });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('OAuth を渡さなければ認証ありのエンドポイントを生やさない', async () => {
    const { app } = createPublicApp();
    const response = await mcpRequest(app, '/auth/mcp', { method: 'tools/list' });
    expect(response.status).toBe(404);
  });
});
