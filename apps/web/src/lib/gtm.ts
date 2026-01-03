// GTM ID（環境変数から取得、未設定の場合は空文字）
export const GTM_ID = process.env.NEXT_PUBLIC_GOOGLE_TAG_MANAGER_ID || '';

// GTM IDの型
export type GoogleTagManagerId = `GTM-${string}`;

// GTMが有効かどうかを判定
export const isGtmEnabled = (): boolean => {
  return GTM_ID !== '' && GTM_ID.startsWith('GTM-');
};

// Window型拡張（dataLayer用）
declare global {
  interface Window {
    dataLayer: Record<string, unknown>[];
  }
}

// カスタムイベント送信関数（将来の拡張用）
export const sendGTMEvent = (event: Record<string, unknown>): void => {
  if (typeof window !== 'undefined' && window.dataLayer) {
    window.dataLayer.push(event);
  }
};
