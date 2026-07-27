// Neovim (Lua) → サーバー: stdin の NDJSON (1 行 1 JSON)
export type InboundMessage =
  | { type: 'update'; bufnr: number; text: string; path?: string }
  | { type: 'cursor'; bufnr: number; line: number; lineCount: number }
  | { type: 'shutdown' };

// サーバー → Neovim: stdout の NDJSON。ready は起動時に 1 回、
// open は記事一覧クリック時（Neovim 側で :edit してバッファを付け替える）
export type StdoutMessage = { type: 'ready'; port: number } | { type: 'open'; path: string };

// サーバー → ブラウザ: WebSocket
export type OutboundMessage =
  | { type: 'html'; html: string; path: string | null }
  | { type: 'scroll'; ratio: number };

// ブラウザ → サーバー: WebSocket（記事一覧のクリック）
export type BrowserMessage = { type: 'open'; path: string };
