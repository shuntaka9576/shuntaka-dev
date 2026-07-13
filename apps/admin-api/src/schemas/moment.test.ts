import { describe, expect, test } from 'bun:test';
import { MOMENT_TEXT_MAX, createMomentBodySchema } from './moment.js';

const validImageKey = 'images/moments/01JZX3F4G5H6J7K8M9N0P1Q2R3.webp';
const validCapturedAt = '2026-07-12T14:30:00.000Z';

describe('createMomentBodySchema', () => {
  test('text は 180 文字ちょうどまで、181 文字は拒否', () => {
    const base = { imageKey: validImageKey, capturedAt: validCapturedAt };
    expect(
      createMomentBodySchema.safeParse({ ...base, text: 'あ'.repeat(MOMENT_TEXT_MAX) }).success,
    ).toBe(true);
    expect(
      createMomentBodySchema.safeParse({ ...base, text: 'あ'.repeat(MOMENT_TEXT_MAX + 1) }).success,
    ).toBe(false);
  });

  test('imageKey は orig の key パターンのみ許容 (thumb や旧プレフィックスは拒否)', () => {
    const base = { text: 'a', capturedAt: validCapturedAt };
    expect(createMomentBodySchema.safeParse({ ...base, imageKey: validImageKey }).success).toBe(
      true,
    );
    expect(
      createMomentBodySchema.safeParse({
        ...base,
        imageKey: 'images/moments/01JZX3F4G5H6J7K8M9N0P1Q2R3_thumb.webp',
      }).success,
    ).toBe(false);
    expect(
      createMomentBodySchema.safeParse({
        ...base,
        imageKey: 'images/logs/01JZX3F4G5H6J7K8M9N0P1Q2R3.webp',
      }).success,
    ).toBe(false);
  });

  test('fastenerColor は fastener=tape のときのみ許容', () => {
    const base = {
      text: 'a',
      imageKey: validImageKey,
      capturedAt: validCapturedAt,
      fastenerColor: 'pink',
    } as const;
    expect(createMomentBodySchema.safeParse({ ...base, fastener: 'tape' }).success).toBe(true);
    expect(createMomentBodySchema.safeParse({ ...base, fastener: 'clip' }).success).toBe(false);
  });

  test('capturedAt は必須で ISO 8601 のみ許容', () => {
    const base = { text: 'a', imageKey: validImageKey };
    expect(createMomentBodySchema.safeParse(base).success).toBe(false);
    expect(createMomentBodySchema.safeParse({ ...base, capturedAt: '2026-07-12' }).success).toBe(
      false,
    );
    expect(createMomentBodySchema.safeParse({ ...base, capturedAt: validCapturedAt }).success).toBe(
      true,
    );
  });
});
