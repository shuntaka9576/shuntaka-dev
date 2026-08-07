/**
 * bundle-size workflow 用の blog-api スタブ。
 * next build 時の SSG (sitemap / feed / 記事一覧・詳細 / moments prerender) が要求する
 * エンドポイントに固定データを返す。レスポンス形は apps/web/src/lib/api.ts に合わせる。
 *
 * usage: bun .github/actions/bundle-size/api-stub.ts (PORT で上書き可、デフォルト 8080)
 */

const port = Number(process.env.PORT || 8080);

const article = {
  articleId: 'bundle-size-stub',
  title: 'Bundle Size Stub',
  slug: 'bundle-size-stub',
  content: 'Bundle size report fixture.',
  contentHtml: '<p>Bundle size report fixture.</p>',
  description: 'Bundle size report fixture.',
  thumbnail: null,
  ogpUrl: 'https://example.com/bundle-size-stub.png',
  tags: [],
  publishedAt: '2026-01-01T00:00:00Z',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const server = Bun.serve({
  port,
  fetch(req) {
    const { pathname } = new URL(req.url);

    // GET /users/:userName/articles/tag-facets → TagFacetsResult
    if (/^\/users\/[^/]+\/articles\/tag-facets$/.test(pathname)) {
      return Response.json({ facets: [] });
    }

    // GET /users/:userName/articles → ArticlesPage
    if (/^\/users\/[^/]+\/articles$/.test(pathname)) {
      return Response.json({
        articles: [article],
        totalCount: 1,
        page: 1,
        perPage: 20,
        totalPages: 1,
      });
    }

    // GET /users/:userName/moments → MomentsPage
    if (/^\/users\/[^/]+\/moments$/.test(pathname)) {
      return Response.json({ moments: [], nextCursor: null });
    }

    // GET /users/:userName/articles/:slug → Article
    if (/^\/users\/[^/]+\/articles\/bundle-size-stub$/.test(pathname)) {
      return Response.json(article);
    }

    return new Response('Not Found', { status: 404 });
  },
});

console.log(`api stub listening on :${server.port}`);
