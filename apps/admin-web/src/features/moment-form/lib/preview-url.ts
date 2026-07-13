// apps/web の /moments/preview (フェーズ 4 で実装) を新規タブで開くための URL。
// 画像はアップロード済みの公開 URL、テキスト等は query で渡すため認証不要で
// 本番同一のレンダリングを確認できる
export const buildPreviewUrl = (input: {
  imageKey: string;
  text: string;
  fastener: string;
  fastenerColor: string | null;
  /** YYYY-MM-DD。null なら今日の日付 */
  date: string | null;
}): string => {
  const base = import.meta.env.VITE_PREVIEW_BASE_URL ?? '';
  const imagesBase = import.meta.env.VITE_IMAGES_BASE_URL ?? '';
  const params = new URLSearchParams();
  params.set('img', `${imagesBase}/${input.imageKey}`);
  params.set('text', input.text);
  params.set('fastener', input.fastener);
  if (input.fastenerColor !== null) params.set('color', input.fastenerColor);
  params.set('date', input.date ?? new Date().toISOString().slice(0, 10));
  return `${base}/moments/preview?${params.toString()}`;
};
