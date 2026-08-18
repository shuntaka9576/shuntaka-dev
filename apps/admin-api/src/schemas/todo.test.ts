import { describe, expect, it } from 'bun:test';
import { updateMorningAchievementBodySchema } from './todo.js';

describe('updateMorningAchievementBodySchema', () => {
  it('育児負荷・自由時間・使い方を許可する', () => {
    expect(
      updateMorningAchievementBodySchema.safeParse({
        parentingLoad: 'heavy',
        freeMinutes: 60,
        allocation: 'study',
        note: '数学を進めた',
      }).success,
    ).toBe(true);
  });

  it('自由時間なしで使い方が指定されていれば拒否する', () => {
    expect(
      updateMorningAchievementBodySchema.safeParse({
        parentingLoad: 'normal',
        freeMinutes: 0,
        allocation: 'study',
        note: '',
      }).success,
    ).toBe(false);
  });
});
