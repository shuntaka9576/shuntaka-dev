import { describe, expect, test } from 'bun:test';
import { decodeCursor, encodeCursor } from './cursor.js';

const momentId = '01JZX3F4G5H6J7K8M9N0P1Q2R3';

describe('cursor', () => {
  test('encode → decode で往復できる', () => {
    expect(decodeCursor(encodeCursor({ momentId }))).toEqual({ momentId });
  });

  test('不正な文字列は null', () => {
    expect(decodeCursor('!!!not-base64url!!!')).toBeNull();
    expect(
      decodeCursor(Buffer.from(JSON.stringify({ momentId: 'short' })).toString('base64url')),
    ).toBeNull();
  });
});
