import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import type { ServerWebSocket } from 'bun';
import { isPathInDir, listArticles, stripFrontmatter } from './articles.js';
import { renderMarkdown } from './markdown.js';
import { readGlobalsCss, renderShellPage, renderViewPage } from './template.js';
import type { BrowserMessage, InboundMessage, OutboundMessage, StdoutMessage } from './protocol.js';

let latestHtml: string | null = null;
let currentPath: string | null = null;
const clients = new Set<ServerWebSocket<unknown>>();

// 記事一覧の対象ディレクトリ。既定はプレビュー中のファイルと同じディレクトリ
function articlesDir(): string | null {
  const env = process.env.SHUNTAKA_PREVIEW_ARTICLES_DIR;
  if (env) {
    return env;
  }
  return currentPath ? dirname(currentPath) : null;
}

function emitStdout(msg: StdoutMessage): void {
  console.log(JSON.stringify(msg));
}

function broadcast(msg: OutboundMessage): void {
  const payload = JSON.stringify(msg);
  for (const ws of clients) {
    ws.send(payload);
  }
}

const server = Bun.serve({
  // ローカル専用ツールなので LAN には公開しない
  hostname: '127.0.0.1',
  // エフェメラルポート。既存 dev サーバー群 (web/api/docs 等の固定ポート) と衝突しない
  port: Number(process.env.SHUNTAKA_PREVIEW_PORT ?? 0),
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === '/ws') {
      return srv.upgrade(req) ? undefined : new Response('upgrade failed', { status: 400 });
    }
    if (url.pathname === '/globals.css') {
      return new Response(readGlobalsCss(), { headers: { 'content-type': 'text/css' } });
    }
    if (url.pathname === '/client.js') {
      return new Response(Bun.file(join(import.meta.dir, '../static/client.js')));
    }
    if (url.pathname === '/toc.js') {
      return new Response(Bun.file(join(import.meta.dir, '../static/toc.js')));
    }
    if (url.pathname === '/favicon.png') {
      return new Response(Bun.file(join(import.meta.dir, '../static/favicon.png')));
    }
    if (url.pathname === '/articles') {
      const dir = articlesDir();
      return Response.json({ articles: dir ? listArticles(dir) : [], current: currentPath });
    }
    if (url.pathname === '/view') {
      return new Response(renderViewPage(latestHtml ?? ''), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    return new Response(renderShellPage(), {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  },
  websocket: {
    open(ws) {
      clients.add(ws);
      // サーバー起動→ブラウザ接続の間に変換済みの HTML があれば即時反映する
      if (latestHtml !== null) {
        const msg: OutboundMessage = { type: 'html', html: latestHtml, path: currentPath };
        ws.send(JSON.stringify(msg));
      }
    },
    close(ws) {
      clients.delete(ws);
    },
    message(_ws, raw) {
      let msg: BrowserMessage;
      try {
        msg = JSON.parse(String(raw)) as BrowserMessage;
      } catch {
        return;
      }
      if (msg.type === 'open' && typeof msg.path === 'string') {
        void handleOpen(msg.path);
      }
    },
  },
});

emitStdout({ type: 'ready', port: server.port ?? 0 });

// 変換の単一フライト方式: 変換中に届いた update は最新 1 件だけ保持し、完了後に処理する
let queuedText: string | null = null;
let rendering = false;

async function handleUpdate(text: string): Promise<void> {
  queuedText = text;
  if (rendering) {
    return;
  }
  rendering = true;
  try {
    while (queuedText !== null) {
      const target = queuedText;
      queuedText = null;
      latestHtml = await renderMarkdown(stripFrontmatter(target));
      broadcast({ type: 'html', html: latestHtml, path: currentPath });
    }
  } catch (e) {
    console.error(`render error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    rendering = false;
  }
}

// 記事一覧クリック: Neovim に :edit を依頼しつつ、ファイル内容を即時レンダリングする
async function handleOpen(path: string): Promise<void> {
  const dir = articlesDir();
  if (!path.endsWith('.md') || !dir || !isPathInDir(path, dir)) {
    return;
  }
  currentPath = path;
  emitStdout({ type: 'open', path });
  try {
    const text = await Bun.file(path).text();
    await handleUpdate(text);
  } catch (e) {
    console.error(`open error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function shutdown(): void {
  void server.stop(true);
  process.exit(0);
}
process.on('SIGTERM', shutdown);

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (line === '') {
    return;
  }
  let msg: InboundMessage;
  try {
    msg = JSON.parse(line) as InboundMessage;
  } catch {
    console.error(`invalid message: ${line}`);
    return;
  }
  if (msg.type === 'update') {
    if (msg.path) {
      currentPath = msg.path;
    }
    void handleUpdate(msg.text);
  } else if (msg.type === 'cursor') {
    const ratio = msg.lineCount > 1 ? (msg.line - 1) / (msg.lineCount - 1) : 0;
    broadcast({ type: 'scroll', ratio });
  } else if (msg.type === 'shutdown') {
    shutdown();
  }
});
// stdin EOF は Neovim 側の異常終了とみなしてサーバーも道連れにする
rl.on('close', shutdown);
