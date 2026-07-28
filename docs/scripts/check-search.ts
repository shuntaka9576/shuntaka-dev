import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

type SearchResult = {
  data: () => Promise<{
    meta?: { title?: string };
    url: string;
  }>;
};

type PagefindInstance = {
  destroy: () => Promise<void>;
  search: (query: string) => Promise<{ results: SearchResult[] }>;
};

type PagefindModule = {
  createInstance: (options: {
    basePath: string;
    language: string;
    noWorker: boolean;
  }) => PagefindInstance;
};

const cases = [
  {
    query: 'クラスタ',
    expectedPath: '/01_開発ドキュメント/02_cluster.html',
  },
  {
    query: 'ローリングアップグレード',
    expectedPath: '/98_tasks/2026-07-10-tidb-cluster-upgrade/',
  },
  {
    query: '記事タグ',
    expectedPath: '/98_tasks/2026-07-05-article-tags/',
  },
  {
    query: '全消し 作り直し',
    expectedPath: '/98_tasks/2026-06-27-tidb-full-rebuild/',
  },
  {
    query: '撮影時刻',
    expectedPath: '/98_tasks/2026-07-14-moments-exif-captured-at/',
  },
] as const;

const buildDirectory = resolve(import.meta.dir, '../build');
const pagefindEntry = resolve(buildDirectory, 'pagefind/pagefind.js');

if (!(await Bun.file(pagefindEntry).exists())) {
  throw new Error('Pagefind index is missing. Run `bun run build-search` first.');
}

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const pathname = decodeURIComponent(new URL(request.url).pathname);
    const filePath = resolve(buildDirectory, `.${pathname}`);
    const isInsideBuild =
      filePath === buildDirectory || filePath.startsWith(`${buildDirectory}${sep}`);

    if (!isInsideBuild) {
      return new Response('Bad Request', { status: 400 });
    }

    const file = Bun.file(filePath);
    if (!(await file.exists())) {
      return new Response('Not Found', { status: 404 });
    }

    return new Response(file);
  },
});

const pagefind = (await import(pathToFileURL(pagefindEntry).href)) as PagefindModule;
const instance = pagefind.createInstance({
  basePath: `http://127.0.0.1:${server.port}/pagefind/`,
  language: 'ja',
  noWorker: true,
});

let failed = false;

try {
  for (const testCase of cases) {
    const search = await instance.search(testCase.query);
    const results = await Promise.all(search.results.map((result) => result.data()));
    const rank =
      results.findIndex(
        (result) => decodeURIComponent(new URL(result.url).pathname) === testCase.expectedPath,
      ) + 1;
    const passed = rank > 0;
    const rankLabel = rank > 0 ? `${rank}位` : '圏外';

    console.log(
      `${passed ? 'PASS' : 'FAIL'} ${testCase.query}: 期待ページ=${passed ? 'ヒット' : '未検出'}, 参考順位=${rankLabel}, ヒット数=${results.length}ページ, 合格条件=期待ページを取得`,
    );
    if (!passed) {
      failed = true;
    }
  }
} finally {
  await instance.destroy();
  await server.stop(true);
}

if (failed) {
  throw new Error('Japanese search quality check failed.');
}
