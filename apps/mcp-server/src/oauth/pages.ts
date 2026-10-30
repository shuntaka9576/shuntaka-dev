// cspell:ignore Kaku Meiryo
// 認可サーバーがブラウザに返す HTML (同意画面とエラー画面)。文言は英語。埋め込む値はすべてエスケープする。
//
// 見た目は apps/web/DESIGN.md に沿う。トークンは apps/web/src/app/globals.css と同じ名前・同じ値を
// この画面で使う分だけ写している (apps/web のスタイルシートは別ドメインのため読み込まない)。
// アクセント色・影・グラデーション・絵文字は使わず、マスコット (ochaIcon) はフルカラーのまま載せる
export const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
  );

/** apps/web/public/assets/ochaIcon.svg と同じ */
const OCHA_ICON = `<svg width="19" height="22" viewBox="0 0 20 24" fill="none" aria-hidden="true">
<path d="M19.2 3.42857C19.2 3.464 19.1985 3.49931 19.1955 3.53448L18.9818 8.57143L19.2 13.7143L19.0183 17.9978C18.994 18.5696 19.057 19.1504 18.9484 19.7123C18.6011 21.5094 16.4525 24 9.6 24C3.93842 24 1.36406 21.4771 0.508297 19.6776C0.258732 19.1528 0.205796 18.5652 0.181165 17.9846L0 13.7143L0.218182 8.57143L0.00449329 3.53448C0.00150496 3.49931 0 3.464 0 3.42857C0 1.53502 4.29807 0 9.6 0C14.9019 0 19.2 1.53502 19.2 3.42857Z" fill="#6E9050"/>
<path fill-rule="evenodd" clip-rule="evenodd" d="M1.14475 4.83936C1.10918 4.72797 1.09091 4.61474 1.09091 4.5C1.09091 2.84315 4.90056 1.5 9.6 1.5C14.2994 1.5 18.1091 2.84315 18.1091 4.5C18.1091 4.61474 18.0908 4.72798 18.0553 4.83937C16.4338 5.91316 13.2555 6.64286 9.60001 6.64286C5.94449 6.64286 2.76618 5.91316 1.14475 4.83936Z" fill="#BDE030"/>
</svg>`;

const STYLE = `
:root {
  --color-bg: #f7fafc;
  --color-surface: #ffffff;
  --color-surface-raised: #fffefc;
  --color-text: #525457;
  --color-text-muted: #57595b8a;
  --color-border: #c4c4c4;
  --color-border-subtle: rgba(162, 177, 202, 0.3);
  --fs-h3: 1.25rem;
  --fs-body: 0.9375rem;
  --fs-caption: 0.8125rem;
  --lh-heading: 1.4;
  --lh-list: 1.7;
  --fw-regular: 400;
  --fw-semibold: 600;
  --font-base: -apple-system, BlinkMacSystemFont, 'Hiragino Kaku Gothic ProN', 'Hiragino Sans', Meiryo, sans-serif;
  --font-latin-ui: BlinkMacSystemFont, Arial, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
  --space-2: 0.5rem;
  --space-3: 0.75rem;
  --space-4: 1rem;
  --space-5: 1.5rem;
  --space-6: 2rem;
  --space-10: 4.5rem;
  --radius-sm: 0.25rem;
  --radius-lg: 0.9375rem;
}
@media (prefers-color-scheme: dark) {
  :root {
    --color-bg: #22272e;
    --color-surface: #22272e;
    --color-surface-raised: #2d333b;
    --color-text: #c9d5e1;
    --color-text-muted: rgb(255 255 255 / 47%);
    --color-border: #30363d;
    --color-border-subtle: rgba(247, 250, 252, 0.3);
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: var(--space-10) var(--space-4);
  background: var(--color-bg);
  color: var(--color-text);
  font-family: var(--font-base);
  font-size: var(--fs-body);
  font-weight: var(--fw-regular);
  line-height: var(--lh-list);
}
main {
  max-width: 30rem;
  margin: 0 auto;
  padding: var(--space-6);
  background: var(--color-surface);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-lg);
}
.brand { display: flex; align-items: center; gap: var(--space-2); margin-bottom: var(--space-5); }
.logo { font-family: var(--font-latin-ui); font-weight: var(--fw-semibold); }
h1 { margin: 0 0 var(--space-3); font-size: var(--fs-h3); font-weight: var(--fw-semibold); line-height: var(--lh-heading); }
p { margin: 0 0 var(--space-4); }
dl { margin: 0 0 var(--space-4); border-top: 1px solid var(--color-border-subtle); }
dt { padding-top: var(--space-3); font-size: var(--fs-caption); color: var(--color-text-muted); }
dd { margin: 0; padding-bottom: var(--space-3); border-bottom: 1px solid var(--color-border-subtle); overflow-wrap: anywhere; }
.mono { font-family: var(--font-mono); font-size: var(--fs-caption); }
.note { font-size: var(--fs-caption); color: var(--color-text-muted); }
form { display: flex; justify-content: flex-end; gap: var(--space-3); margin-top: var(--space-5); }
button {
  height: 2.5rem;
  padding: 0 var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface-raised);
  color: var(--color-text);
  font: inherit;
  font-weight: var(--fw-semibold);
  cursor: pointer;
}
button:hover { background: var(--color-surface); }
button:active { filter: brightness(95%); }
button.primary { border-color: var(--color-text); background: var(--color-text); color: var(--color-bg); }
button.primary:hover { filter: brightness(95%); }
button.primary:active { filter: brightness(90%); }
button:focus-visible { outline: 2px solid var(--color-text); outline-offset: 2px; }
`;

/** ブランドに沿った 1 枚の画面。body は呼び出し側でエスケープ済みの HTML */
export const brandedPage = (title: string, body: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} | shuntaka.dev</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<div class="brand">${OCHA_ICON}<span class="logo">shuntaka.dev</span></div>
${body}
</main>
</body>
</html>`;

/**
 * 同意画面。クライアント名は DCR での自己申告なので、許可リストで確かめた戻り先も並べて見せる
 */
export const consentPage = (input: {
  clientName: string | undefined;
  redirectUri: string;
  transactionId: string;
}) =>
  brandedPage(
    'Connect to the blog',
    `<h1>Connect to the blog</h1>
<p>This client is requesting access to search and read the public articles on the blog.</p>
<dl>
<dt>Client name (as reported by the client)</dt>
<dd>${escapeHtml(input.clientName ?? '(unnamed)')}</dd>
<dt>Redirects to after approval</dt>
<dd class="mono">${escapeHtml(input.redirectUri)}</dd>
</dl>
<p class="note">If you approve, you will be taken to the Cognito sign-in page.</p>
<form method="post" action="/oauth/consent">
<input type="hidden" name="transaction_id" value="${escapeHtml(input.transactionId)}">
<button type="submit" name="action" value="deny">Deny</button>
<button type="submit" name="action" value="approve" class="primary">Approve</button>
</form>`,
  );

/** クライアントに戻せないエラー (クライアントや戻り先が確かめられない、ブラウザが一致しないなど) */
export const errorPage = (message: string) =>
  brandedPage('Cannot connect', `<h1>Cannot connect</h1>\n<p>${escapeHtml(message)}</p>`);
