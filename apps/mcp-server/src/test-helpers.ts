import {
  type AttributeValue,
  ConditionalCheckFailedException,
  DeleteItemCommand,
  GetItemCommand,
  PutItemCommand,
} from '@aws-sdk/client-dynamodb';
import { BlogApiClient } from './blog-api.js';

/**
 * PutItem / GetItem / DeleteItem だけを Map で再現する DynamoDB クライアント。
 * 条件付き PutItem は DynamoDbStore.replace が使う `#value = :expected` だけを扱う
 */
export class FakeDynamoDb {
  readonly items = new Map<string, Record<string, AttributeValue>>();

  async send(command: unknown): Promise<object> {
    if (command instanceof PutItemCommand) {
      const item = command.input.Item ?? {};
      const key = item.pk?.S ?? '';
      if (
        command.input.ConditionExpression === '#value = :expected' &&
        this.items.get(key)?.value?.S !== command.input.ExpressionAttributeValues?.[':expected']?.S
      ) {
        throw new ConditionalCheckFailedException({
          message: 'The conditional request failed',
          $metadata: {},
        });
      }
      this.items.set(key, item);
      return {};
    }
    if (command instanceof GetItemCommand) {
      return { Item: this.items.get(command.input.Key?.pk?.S ?? '') };
    }
    if (command instanceof DeleteItemCommand) {
      const key = command.input.Key?.pk?.S ?? '';
      const old = this.items.get(key);
      this.items.delete(key);
      return command.input.ReturnValues === 'ALL_OLD' ? { Attributes: old } : {};
    }
    throw new Error(`unsupported command: ${String(command)}`);
  }
}

const article = {
  articleId: 'a1',
  title: 'Lambda Web Functions を試す',
  slug: 'lambda-web-functions',
  description: 'Web Functions の検証',
  thumbnail: null,
  ogpUrl: 'https://example.com/ogp.png',
  tags: ['tech/aws/lambda'],
  publishedAt: '2026-10-15T00:00:00Z',
  createdAt: '2026-10-15T00:00:00Z',
  updatedAt: '2026-10-16T00:00:00Z',
};

/** blog-api の公開 API を返す fetch。呼ばれた URL を記録する */
export const createFakeBlogApi = () => {
  const requests: URL[] = [];
  const rawUrls: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    const raw = input instanceof Request ? input.url : String(input);
    rawUrls.push(raw);
    const url = new URL(raw);
    requests.push(url);
    const path = url.pathname.replace('/api/users/shuntaka', '');
    if (path === '/articles') {
      return Response.json({
        articles: [article],
        totalCount: 1,
        page: 1,
        perPage: 20,
        totalPages: 1,
      });
    }
    if (path === '/articles/search') {
      return Response.json({
        articles: [{ ...article, distance: 0.12 }],
        query: url.searchParams.get('q'),
        limit: 10,
        offset: 0,
        totalCount: 1,
      });
    }
    if (path === '/articles/tag-facets') {
      return Response.json({ facets: [{ path: 'tech/aws', count: 3 }] });
    }
    if (path === `/articles/${article.slug}`) {
      return Response.json({ ...article, content: '# 本文', contentHtml: '<h1>本文</h1>' });
    }
    return Response.json({ error: 'NotFound', message: 'not found' }, { status: 404 });
  }) as typeof globalThis.fetch;
  return {
    requests,
    rawUrls,
    client: new BlogApiClient({ baseUrl: 'https://example.com/api', userName: 'shuntaka', fetch }),
  };
};

const MCP_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

/** JSON-RPC の応答を読む。2025 年版のステートレス応答は 1 件だけの SSE で返る */
export const readMcpResponse = async (response: Response) => {
  const text = await response.text();
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    return JSON.parse(text);
  }
  const data = text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice('data: '.length));
  return JSON.parse(data.at(-1) ?? 'null');
};

/** 2025 年版 (セッションなし) の Streamable HTTP で JSON-RPC を 1 件送る */
export const mcpRequest = (
  app: { request: (path: string, init: RequestInit) => Response | Promise<Response> },
  path: string,
  body: { method: string; params?: Record<string, unknown> },
  headers: Record<string, string> = {},
) =>
  app.request(path, {
    method: 'POST',
    headers: { ...MCP_HEADERS, 'mcp-protocol-version': '2025-06-18', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }),
  });
