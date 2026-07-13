import type { AppType } from '@shuntaka-dev/admin-api';
import { hc } from 'hono/client';

/**
 * 型付き Hono RPC クライアント。
 *
 * `AppType` は admin-api ワークスペースから type-only import しているため、
 * すべてのルートとレスポンスがエンドツーエンドで型付けされる。
 * admin-api は `basePath('/api')` を持つため baseUrl はオリジンルートで、
 * 呼び出しは `client.api.moments.$get()` の形になる。開発時は Vite が `/api` を
 * admin-api へプロキシする (vite.config.ts)。
 */
export const client = hc<AppType>('/', {
  init: {
    // セッション Cookie (HttpOnly) を同送する
    credentials: 'same-origin',
  },
  // 変更系リクエストはバックエンドの CSRF チェックで X-Requested-With が必須。
  // init.headers に書くと fetch init が最後に spread され、hono/client が付与する
  // Content-Type: application/json ごと上書きして消えるため headers オプションで渡す
  headers: { 'x-requested-with': 'XMLHttpRequest' },
});
