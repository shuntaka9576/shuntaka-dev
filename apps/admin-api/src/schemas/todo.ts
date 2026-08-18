import { z } from '@hono/zod-openapi';

export const todoPeriodSchema = z.enum(['morning', 'bedtime']);
export const mealTypeSchema = z.enum(['breakfast', 'lunch', 'dinner']);
export const todoQuickCategorySchema = z.enum(['task', 'blog_idea']);
export const localDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const localMonthSchema = z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/);
export const generationTimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);

export const todoTemplateInputSchema = z.object({
  key: z.string().min(1).max(64),
  parentKey: z.string().min(1).max(64).nullable(),
  period: todoPeriodSchema,
  title: z.string().trim().min(1).max(1000),
  position: z.number().int().min(0),
});

export const updateTodoSettingsBodySchema = z.object({
  timezone: z.string().min(1).max(64).default('Asia/Tokyo'),
  generationTime: generationTimeSchema,
  sourceMarkdown: z.string().min(1).max(100_000),
  items: z.array(todoTemplateInputSchema).max(250),
});

export const updateTodoItemBodySchema = z.object({ completed: z.boolean() });
export const todoItemIdParamSchema = z.object({ id: z.string().length(26) });

export const mealParamsSchema = z.object({ date: localDateSchema, type: mealTypeSchema });
export const updateMealBodySchema = z.object({ content: z.string().trim().max(1000) });

export const createShoppingItemBodySchema = z.object({
  name: z.string().trim().min(1).max(500),
  quantity: z.string().trim().max(255).optional(),
});
export const shoppingItemIdParamSchema = z.object({ id: z.string().length(26) });

export const todoDashboardQuerySchema = z.object({ date: localDateSchema.optional() });
export const todoCalendarQuerySchema = z.object({ month: localMonthSchema.optional() });
export const createQuickItemBodySchema = z.object({
  category: todoQuickCategorySchema,
  title: z.string().trim().min(1).max(1000),
});
export const updateQuickItemBodySchema = z.object({ completed: z.boolean() });
export const quickItemIdParamSchema = z.object({ id: z.string().length(26) });
export const morningAchievementDateParamSchema = z.object({ date: localDateSchema });
export const parentingLoadSchema = z.enum(['none', 'light', 'normal', 'heavy']);
export const morningAllocationSchema = z.enum([
  'none',
  'idle',
  'exercise',
  'study',
  'exercise_study',
]);
export const morningFreeMinutesSchema = z.union([
  z.literal(0),
  z.literal(30),
  z.literal(60),
  z.literal(90),
  z.literal(120),
]);
export const morningAchievementSchema = z.object({
  parentingLoad: parentingLoadSchema,
  freeMinutes: morningFreeMinutesSchema,
  allocation: morningAllocationSchema,
  note: z.string().max(2000),
});
export const updateMorningAchievementBodySchema = morningAchievementSchema.superRefine(
  (value, context) => {
    const valid =
      (value.freeMinutes === 0 && value.allocation === 'none') ||
      (value.freeMinutes > 0 && value.allocation !== 'none');
    if (!valid) context.addIssue({ code: 'custom', message: 'allocation must match free time' });
  },
);

const todoSettingsSchema = z.object({
  timezone: z.string(),
  generationTime: generationTimeSchema,
  sourceMarkdown: z.string(),
  items: z.array(todoTemplateInputSchema),
});

const dailyTodoItemSchema = z.object({
  itemId: z.string(),
  parentItemId: z.string().nullable(),
  period: todoPeriodSchema,
  title: z.string(),
  position: z.number().int(),
  completedAt: z.string().nullable(),
});

const mealSchema = z.object({
  date: localDateSchema,
  breakfast: z.string().nullable(),
  lunch: z.string().nullable(),
  dinner: z.string().nullable(),
});

export const shoppingItemSchema = z.object({
  itemId: z.string(),
  name: z.string(),
  quantity: z.string().nullable(),
});

export const quickItemSchema = z.object({
  itemId: z.string(),
  category: todoQuickCategorySchema,
  title: z.string(),
  completedAt: z.string().nullable(),
});

export const todoDashboardSchema = z
  .object({
    date: localDateSchema,
    today: localDateSchema,
    settings: todoSettingsSchema.nullable(),
    checklist: z.array(dailyTodoItemSchema),
    morningAchievement: morningAchievementSchema.nullable(),
    quickTodos: z.array(quickItemSchema),
    meals: z.array(mealSchema),
    shopping: z.array(shoppingItemSchema),
  })
  .openapi('TodoDashboard');

export const todoCalendarSchema = z
  .object({
    month: localMonthSchema,
    today: localDateSchema,
    days: z.array(
      z.object({
        date: localDateSchema,
        total: z.number().int().nonnegative(),
        completed: z.number().int().nonnegative(),
        hasMorningAchievement: z.boolean(),
      }),
    ),
  })
  .openapi('TodoCalendar');

export const generateTodoResponseSchema = z.object({ date: localDateSchema, created: z.number() });

export type TodoTemplateInput = z.infer<typeof todoTemplateInputSchema>;
