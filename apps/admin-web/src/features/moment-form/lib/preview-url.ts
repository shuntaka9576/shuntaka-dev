// apps/web の /moments/preview (フェーズ 4 で実装) を新規タブで開くための URL。
// 画像はアップロード済みの公開 URL、テキスト等は query で渡すため認証不要で
// 本番同一のレンダリングを確認できる
export const buildPreviewUrl = (input: {
  imageKey: string;
  text: string;
  fastener: string;
  fastenerColor: string | null;
  /** 撮影時刻 (ISO 8601) */
  capturedAt: string;
}): string => {
  const base = import.meta.env.VITE_PREVIEW_BASE_URL ?? '';
  const imagesBase = import.meta.env.VITE_IMAGES_BASE_URL ?? '';
  const params = new URLSearchParams();
  params.set('img', `${imagesBase}/${input.imageKey}`);
  params.set('text', input.text);
  params.set('fastener', input.fastener);
  if (input.fastenerColor !== null) params.set('color', input.fastenerColor);
  params.set('date', input.capturedAt);
  return `${base}/moments/preview?${params.toString()}`;
};
