export interface RedirectUriPolicy {
  /** DCR で登録を許す HTTPS のホスト。`*.example.com` はサブドメインに一致する */
  httpsHosts: string[];
  /**
   * DCR で登録を許す HTTPS のリダイレクト URI (入力文字列との完全一致)。
   * `www.cursor.com` のようにサイト全体を許したくないホストはホストではなくここで許す
   */
  httpsExactUris?: string[];
}

/**
 * 接続を想定する MCP クライアントのリダイレクト先。Muse の 3 つは記事の検証で使った許可リストと同じ
 * (Muse のリダイレクト URI は公開されておらず、ドメイン単位で許可している)
 */
export const DEFAULT_REDIRECT_URI_POLICY: RedirectUriPolicy = {
  httpsHosts: ['agent.meta.ai', 'muse.ai', '*.muse.ai', 'claude.ai', 'claude.com', 'chatgpt.com'],
  // Grok Bot (Cursor) の MCP OAuth コールバック。www.cursor.com は他のページも配信するため、ホストではなく URI で許す
  httpsExactUris: ['https://www.cursor.com/agents/mcp/oauth/callback'],
};

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * DCR で登録できるリダイレクト URI か。glob や前方一致では `http://localhost:80@evil.example/` のような
 * ユーザー情報部でホストを偽装した URI を通してしまうため、URL として分解して判定する
 */
export const isAllowedRedirectUri = (value: string, policy: RedirectUriPolicy): boolean => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username !== '' || url.password !== '' || url.hash !== '') {
    return false;
  }
  // ローカルの MCP クライアント (Claude Code、MCP Inspector など) はループバックの任意ポートで受ける
  if (url.protocol === 'http:') {
    return LOOPBACK_HOSTS.has(url.hostname);
  }
  if (url.protocol !== 'https:' || url.port !== '') {
    return false;
  }
  if (
    policy.httpsHosts.some((host) =>
      host.startsWith('*.') ? url.hostname.endsWith(host.slice(1)) : url.hostname === host,
    )
  ) {
    return true;
  }
  // 入力文字列そのものとの完全一致のみ。`new URL()` の正規化 (`:443`、`/../`、`%2e`、空白、空のクエリ・フラグメント) を経た一致は許さない
  return (policy.httpsExactUris ?? []).includes(value);
};
