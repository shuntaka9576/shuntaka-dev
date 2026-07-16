// cspell:ignore Cmisc

import { describe, expect, test } from 'bun:test';
import {
  buildLocationSearch,
  distanceToAngle,
  distanceToSimilarity,
  parseSearchParam,
} from './searchQuery';

describe('parseSearchParam', () => {
  test('null は空文字になる', () => {
    expect(parseSearchParam(null)).toBe('');
  });

  test('空文字は空文字になる', () => {
    expect(parseSearchParam('')).toBe('');
  });

  test('前後空白を除去する', () => {
    expect(parseSearchParam('  TiDB Vector  ')).toBe('TiDB Vector');
  });

  test('通常の文字列はそのまま', () => {
    expect(parseSearchParam('Rust Axum')).toBe('Rust Axum');
  });
});

describe('buildLocationSearch', () => {
  test('q を追加する（既存パラメータなし）', () => {
    expect(buildLocationSearch('', { q: 'TiDB' })).toBe('?q=TiDB');
  });

  test('q を空にすると q が削除される', () => {
    expect(buildLocationSearch('?q=TiDB&tags=tech', { q: '' })).toBe('?tags=tech');
  });

  test('前後空白の q は trim される', () => {
    expect(buildLocationSearch('', { q: '  Rust  ' })).toBe('?q=Rust');
  });

  test('tags 配列を join してエンコードする', () => {
    expect(buildLocationSearch('', { tags: ['tech/rust', 'misc'] })).toBe(
      '?tags=tech%2Frust%2Cmisc',
    );
  });

  test('tags 空配列は tags を削除する', () => {
    expect(buildLocationSearch('?tags=tech&mode=or', { tags: [] })).toBe('');
  });

  test('mode=or は 2 タグ以上のときだけ書き込む', () => {
    expect(buildLocationSearch('', { tags: ['a', 'b'], mode: 'or' })).toBe('?tags=a%2Cb&mode=or');
    expect(buildLocationSearch('', { tags: ['a'], mode: 'or' })).toBe('?tags=a');
    expect(buildLocationSearch('', { tags: ['a', 'b'], mode: 'and' })).toBe('?tags=a%2Cb');
  });

  test('q と tags と mode を同時に指定できる', () => {
    expect(
      buildLocationSearch('', {
        q: 'TiDB',
        tags: ['tech/rust', 'misc'],
        mode: 'or',
      }),
    ).toBe('?q=TiDB&tags=tech%2Frust%2Cmisc&mode=or');
  });

  test('q だけ更新するとき他のパラメータは維持される', () => {
    expect(buildLocationSearch('?tags=tech&mode=or', { q: 'Rust' })).toBe(
      '?tags=tech&mode=or&q=Rust',
    );
  });

  test('strip=true は q/tags/mode 以外を削除する', () => {
    expect(buildLocationSearch('?page=3&tags=tech&x=y', { strip: true, q: 'Rust' })).toBe(
      '?tags=tech&q=Rust',
    );
  });
});

describe('distanceToSimilarity', () => {
  test('distance=0 は 1.0 (完全一致)', () => {
    expect(distanceToSimilarity(0)).toBe(1);
  });

  test('distance=1 は 0.5', () => {
    expect(distanceToSimilarity(1)).toBe(0.5);
  });

  test('distance=2 は 0 (最遠)', () => {
    expect(distanceToSimilarity(2)).toBe(0);
  });

  test('負の値は 1.0 にクランプ', () => {
    expect(distanceToSimilarity(-0.1)).toBe(1);
  });

  test('2 を超える値は 0 にクランプ', () => {
    expect(distanceToSimilarity(3)).toBe(0);
  });

  test('NaN は 0', () => {
    expect(distanceToSimilarity(Number.NaN)).toBe(0);
  });
});

describe('distanceToAngle', () => {
  test('distance=0 は 0° (同じ向き)', () => {
    expect(distanceToAngle(0)).toBeCloseTo(0);
  });

  test('distance=1 は 90° (直交)', () => {
    expect(distanceToAngle(1)).toBeCloseTo(90);
  });

  test('distance=2 は 180° (正反対)', () => {
    expect(distanceToAngle(2)).toBeCloseTo(180);
  });

  test('負の値は 0° にクランプ', () => {
    expect(distanceToAngle(-0.1)).toBeCloseTo(0);
  });

  test('2 を超える値は 180° にクランプ', () => {
    expect(distanceToAngle(3)).toBeCloseTo(180);
  });

  test('NaN は 180° (最遠)', () => {
    expect(distanceToAngle(Number.NaN)).toBe(180);
  });
});
