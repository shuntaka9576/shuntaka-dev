import { z } from '@hono/zod-openapi';

// 一覧の cursor は moment_id (ULID) 単独。ULID は時系列ソート可能なので
// created_at を併用せずとも並びが安定し、DATETIME(6) のマイクロ秒精度と
// JS Date のミリ秒精度のズレによる境界バグも避けられる
const cursorPayloadSchema = z.object({
  momentId: z.string().length(26),
});

export type MomentCursor = z.infer<typeof cursorPayloadSchema>;

export const encodeCursor = (cursor: MomentCursor): string =>
  Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');

export const decodeCursor = (raw: string): MomentCursor | null => {
  try {
    const json: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    const parsed = cursorPayloadSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};
