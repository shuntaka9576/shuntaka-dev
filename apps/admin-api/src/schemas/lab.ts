import { z } from '@hono/zod-openapi';

// labs-web (apps/labs-web/src/lib/api.ts) と共有する契約。
// プレビュー用モック (apps/labs-web/preview/server.ts) も同じ形を返す

export const labSlugParamSchema = z.object({
  labSlug: z.string().min(1),
});

export const chapterParamSchema = z.object({
  labSlug: z.string().min(1),
  chapterSlug: z.string().min(1),
});

export const labSummarySchema = z.object({
  slug: z.string(),
  title: z.string(),
  summary: z.string().nullable(),
  published: z.boolean(),
  chapterCount: z.number(),
  updatedAt: z.string(),
});

export const chapterMetaSchema = z.object({
  slug: z.string(),
  title: z.string(),
  position: z.number(),
});

export const labListSchema = z.object({
  labs: z.array(labSummarySchema),
});

export const labDetailSchema = z.object({
  lab: labSummarySchema,
  chapters: z.array(chapterMetaSchema),
});

export const chapterDetailSchema = z.object({
  lab: labSummarySchema,
  chapters: z.array(chapterMetaSchema),
  chapter: chapterMetaSchema.extend({ contentHtml: z.string() }),
});
