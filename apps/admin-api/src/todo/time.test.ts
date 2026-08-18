import { describe, expect, it } from 'bun:test';
import { addDays, isValidTimeZone, localDateTime } from './time.js';

describe('localDateTime', () => {
  it('UTC の日付境界を Asia/Tokyo の日付へ変換する', () => {
    expect(localDateTime(new Date('2026-08-18T20:01:00Z'), 'Asia/Tokyo')).toEqual({
      date: '2026-08-19',
      time: '05:01',
    });
  });
});

describe('isValidTimeZone', () => {
  it('IANA timezone だけを許可する', () => {
    expect(isValidTimeZone('Asia/Tokyo')).toBe(true);
    expect(isValidTimeZone('not/a-timezone')).toBe(false);
  });
});

describe('addDays', () => {
  it('月をまたいで加算する', () => {
    expect(addDays('2026-08-31', 1)).toBe('2026-09-01');
  });
});
