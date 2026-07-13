import { z } from '@hono/zod-openapi';

export const MOMENT_TEXT_MAX = 180;

export const fastenerSchema = z.enum(['clip', 'tape']);
export const fastenerColorSchema = z.enum(['pink', 'blue', 'yellow', 'green']);
export const momentStatusSchema = z.enum(['published', 'draft']);

// images バケットの orig key (ULID は crockford Base32 の 26 文字)
// cspell:disable-next-line
export const IMAGE_KEY_PATTERN = /^images\/moments\/[0-9A-HJKMNP-TV-Z]{26}\.webp$/;

export const createMomentBodySchema = z
  .object({
    text: z.string().min(1).max(MOMENT_TEXT_MAX),
    imageKey: z.string().regex(IMAGE_KEY_PATTERN),
    fastener: fastenerSchema.default('clip'),
    fastenerColor: fastenerColorSchema.optional(),
    status: momentStatusSchema.default('published'),
    // 撮影時刻。クライアントが EXIF から補完する (EXIF なしはファイル更新日時 → 現在時刻)
    capturedAt: z.iso.datetime({ offset: true }),
  })
  .refine((v) => v.fastenerColor === undefined || v.fastener === 'tape', {
    message: 'fastenerColor is only valid when fastener is tape',
    path: ['fastenerColor'],
  });

// PATCH は部分更新。fastenerColor は null で「色なし」に戻せる。
// fastener と fastenerColor の組み合わせ制約はマージ後にハンドラ側で検証する
export const updateMomentBodySchema = z.object({
  text: z.string().min(1).max(MOMENT_TEXT_MAX).optional(),
  imageKey: z.string().regex(IMAGE_KEY_PATTERN).optional(),
  fastener: fastenerSchema.optional(),
  fastenerColor: fastenerColorSchema.nullable().optional(),
  status: momentStatusSchema.optional(),
  // 写真を差し替えたときにクライアントが EXIF から再補完して送る
  capturedAt: z.iso.datetime({ offset: true }).optional(),
});

export const listMomentsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const momentSchema = z
  .object({
    momentId: z.string(),
    text: z.string(),
    imageKey: z.string(),
    imageUrl: z.string(),
    thumbUrl: z.string(),
    fastener: fastenerSchema,
    fastenerColor: fastenerColorSchema.nullable(),
    status: momentStatusSchema,
    capturedAt: z.string(),
    // 初回公開時刻の記録。未公開の draft は null (draft に戻しても保持される)
    publishedAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi('Moment');

export const momentListSchema = z
  .object({
    items: z.array(momentSchema),
    nextCursor: z.string().nullable(),
  })
  .openapi('MomentList');

export const momentIdParamSchema = z.object({
  id: z.string().length(26),
});
