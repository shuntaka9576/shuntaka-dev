export interface CompressedImages {
  orig: Blob;
  thumb: Blob;
}

const ORIG_LONG_EDGE = 1440;
const THUMB_LONG_EDGE = 640;
const WEBP_QUALITY = 0.8;

const toWebp = async (bitmap: ImageBitmap, longEdge: number): Promise<Blob> => {
  const scale = Math.min(1, longEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('canvas 2d context を取得できません');
  ctx.drawImage(bitmap, 0, 0, width, height);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob === null) {
          reject(new Error('WebP への変換に失敗しました'));
          return;
        }
        resolve(blob);
      },
      'image/webp',
      WEBP_QUALITY,
    );
  });
};

// 原比率のまま orig (長辺 1440px) と一覧用 thumb (長辺 640px) の 2 サイズを生成する。
// canvas 再エンコードで EXIF (GPS 位置情報含む) は自動的に除去される
export const compressImage = async (file: File): Promise<CompressedImages> => {
  // EXIF の回転情報は落ちる前にピクセルへ反映する
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const [orig, thumb] = await Promise.all([
      toWebp(bitmap, ORIG_LONG_EDGE),
      toWebp(bitmap, THUMB_LONG_EDGE),
    ]);
    return { orig, thumb };
  } finally {
    bitmap.close();
  }
};
