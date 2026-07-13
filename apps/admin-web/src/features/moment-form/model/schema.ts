import { z } from 'zod';

export const MOMENT_TEXT_MAX = 180;

// クライアント専用の zod スキーマ (サーバの検証スキーマとは独立して持つ)
export const momentFormSchema = z.object({
  text: z
    .string()
    .trim()
    .min(1, '本文は必須です')
    .max(MOMENT_TEXT_MAX, `本文は${MOMENT_TEXT_MAX}文字以内で入力してください`),
});
