import { z } from '@hono/zod-openapi';

// クライアント圧縮後の WebP を想定した上限 (orig 5MB / thumb 1MB)。
// presigned PUT では content-length-range を強制できないため宣言値の検証のみ
// (認証済み admin 専用 API なので許容する)
export const MAX_ORIG_BYTES = 5 * 1024 * 1024;
export const MAX_THUMB_BYTES = 1 * 1024 * 1024;

export const presignBodySchema = z.object({
  contentType: z.literal('image/webp'),
  origLength: z.number().int().positive().max(MAX_ORIG_BYTES),
  thumbLength: z.number().int().positive().max(MAX_THUMB_BYTES),
});

export const presignResponseSchema = z
  .object({
    imageKey: z.string(),
    origUrl: z.string(),
    thumbUrl: z.string(),
  })
  .openapi('PresignResponse');
