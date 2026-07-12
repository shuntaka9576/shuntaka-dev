import { client } from '@/shared/api';

import type { CompressedImages } from './compress-image';

// presign で 2 本の PUT URL を取得し、S3 へ orig / thumb を直接アップロードして
// imageKey (orig の key。thumb はサフィックス導出) を返す
export const uploadImages = async (images: CompressedImages): Promise<string> => {
  const res = await client.api.images.presign.$post({
    json: {
      contentType: 'image/webp',
      origLength: images.orig.size,
      thumbLength: images.thumb.size,
    },
  });
  if (!res.ok) throw new Error('アップロード URL の発行に失敗しました');
  const { imageKey, origUrl, thumbUrl } = await res.json();

  const put = async (url: string, body: Blob) => {
    const putRes = await fetch(url, {
      method: 'PUT',
      body,
      headers: { 'content-type': 'image/webp' },
    });
    if (!putRes.ok) throw new Error('画像のアップロードに失敗しました');
  };
  await Promise.all([put(origUrl, images.orig), put(thumbUrl, images.thumb)]);
  return imageKey;
};
