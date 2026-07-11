/**
 * bundle-size workflow 用の blog-api スタブ。
 * next build 時の SSG (sitemap / feed / 記事一覧 prerender) が要求する
 * エンドポイントに空データを返す。レスポンス形は apps/web/src/lib/api.ts に合わせる。
 *
 * usage: bun .github/actions/bundle-size/api-stub.ts (PORT で上書き可、デフォルト 8080)
 */

const port = Number(process.env.PORT || 8080);

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
        articles: [],
        totalCount: 0,
        page: 1,
        perPage: 20,
        totalPages: 0,
      });
    }

    // GET /users/:userName/articles/:slug → 404 (getArticleBySlug は null を返す)
    return new Response('Not Found', { status: 404 });
  },
});

console.log(`api stub listening on :${server.port}`);
