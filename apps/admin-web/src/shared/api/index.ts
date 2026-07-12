import type { AppType } from '@shuntaka-dev/admin-backend';
import { hc } from 'hono/client';

/**
 * 型付き Hono RPC クライアント。
 *
 * `AppType` は admin-backend ワークスペースから type-only import しているため、
 * すべてのルートとレスポンスがエンドツーエンドで型付けされる。
 * admin-backend は `basePath('/api')` を持つため baseUrl はオリジンルートで、
 * 呼び出しは `client.api.moments.$get()` の形になる。開発時は Vite が `/api` を
 * admin-backend へプロキシする (vite.config.ts)。
 */
export const client = hc<AppType>('/', {
  init: {
    // セッション Cookie (HttpOnly) を同送する
    credentials: 'same-origin',
    // 変更系リクエストはバックエンドの CSRF チェックで X-Requested-With が必須
    headers: { 'x-requested-with': 'XMLHttpRequest' },
  },
});
