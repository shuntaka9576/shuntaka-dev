# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ブログ (shuntaka.dev) と同じ変換ロジックで Markdown をローカルプレビューする Neovim プラグイン。`apps/blog-api/markdown` crate の wasm 成果物とローダーは `packages/markdown-wasm`（pkg/ コミット済み）に集約されており、Bun サーバーはそれを呼んで本番とまったく同じ HTML を生成する。スタイルも `apps/web/src/app/globals.css` をそのまま配信して再現する。

構成は 3 層:

- Neovim (Lua) — `:ShuntakaPreview` でバッファに attach し、jobstart で Bun サーバーを起動。バッファ全文とカーソル位置を stdin NDJSON で送る。BufEnter で別の markdown バッファへの移動に追従し、サーバーからの open 通知（記事一覧クリック）では `:edit` する
- Bun サーバー (`src/`) — frontmatter を除去して wasm で Markdown→HTML 変換し、WebSocket でブラウザへ push。shell/view ページ・globals.css・記事一覧 JSON (`/articles`)・favicon も配信する
- ブラウザ (`static/`) — shell ページ（記事一覧サイドバー + pc/mobile 切り替え + iframe）を client.js が制御し、iframe 内の記事ページでは toc.js が目次を組み立てる

## Commands

```bash
# サーバー単体テスト (markdown-wasm のコミット済み pkg/ を使用)
bun run test

# サーバーを手動起動 (stdin に NDJSON を流して動作確認する用)
bun run serve

# wasm 再ビルドは markdown crate 変更時に markdown-wasm 側で行う
(cd ../../packages/markdown-wasm && bun run build:wasm)
```

## Architecture

- `lua/shuntaka-preview/init.lua` — 公開 API (`setup`/`start`/`stop`) とコマンド登録。グローバル 1 セッションで、attach 先バッファは BufEnter / open 通知で付け替わる
- `lua/shuntaka-preview/config.lua` — デフォルト設定と、`debug.getinfo` によるプラグインルート自動検出
- `lua/shuntaka-preview/job.lua` — jobstart のライフサイクル管理と NDJSON 送受信（stdout の行分割バッファリング込み）
- `lua/shuntaka-preview/buffer.lua` — TextChanged/CursorMoved の autocmd 登録と vim.uv timer による debounce
- `src/index.ts` — エントリポイント。Bun.serve (HTTP + WebSocket) と stdin NDJSON ループ。記事一覧クリック (WS open) はパス検証後に stdout 通知 + ファイル内容の即時レンダリング
- `src/protocol.ts` — Lua↔サーバー↔ブラウザ間メッセージの型定義（唯一の型ソース）
- `src/markdown.ts` — markdown-wasm のローダーを使った 2 パス変換（URL 列挙 → fetch → リソース注入）。成功はプロセス寿命、失敗は 30 秒 TTL でキャッシュ
- `src/articles.ts` — frontmatter の除去/title 抽出（blog-api の ArticleFrontmatter::parse と同じ切り出し方）と記事一覧の列挙
- `src/template.ts` — shell ページ（記事一覧 + pc/mobile 切り替え + iframe）と view ページ（本番と同じ article-body レイアウト）、globals.css の取り込み（Tailwind ディレクティブのみ除去）
- `static/client.js` — shell 側。WS 受信を iframe に注入し、記事一覧の描画・ソート・pc/mobile 切り替えを行う
- `static/toc.js` — view (iframe) 側。apps/web の TableOfContents.tsx を移植した目次（スクロール追従・モバイルモーダル込み）
- `static/favicon.png` — 本番 favicon (apps/web/public/icons/icon.png) を色相 +240° 回転したプレビュー識別用アイコン
- ブラウザ側 JS は DOM 型と bun-types が衝突するため素の JS

## Design Notes

- wasm の公開 API は `collectResourceUrls` / `convertMarkdownWithResources` の 2 つ（2 パス方式）。wasm 内で同期 HTTP ができないため、fetch は TS 側で行う。content-html-backfill と同じパターン
- markdown-wasm の参照は workspace 名ではなく相対 import（`../../../packages/markdown-wasm/src/index.js`）。lazy.nvim で入れたマシンでは `bun install` を実行せず node_modules が無いため、名前解決に頼らない形で「bun だけで動く」を維持する
- lazy.nvim はモノレポのサブディレクトリを直接扱えないため、spec の `config` で require の直前に `vim.opt.rtp:append(plugin.dir .. "/tools/shuntaka-preview.nvim")` する（`init` での追加は初回インストールセッションで間に合わない）。`plugin/` ディレクトリは作らず、コマンド登録は `setup()` で行う
- プレビューは記事ページのラッパー構造 (`article-content > article-content-wrapper > .prose`) のみ再現。article-header や目次等のサイト chrome、X ポスト埋め込み (react-tweet) は対象外
- ダークモードは `data-theme` を触らず `prefers-color-scheme` 任せ（本番の未設定時デフォルトと同じ挙動）

## Documentation

使い方と lazy.nvim 導入例は `docs/source/01_開発ドキュメント/01_development.md` の「### shuntaka-preview.nvim」に集約している。コマンドやオプションを変更したら同期すること。
