import { describe, expect, test } from 'bun:test';
import {
  buildFilterQuery,
  buildTagTreeFromFacets,
  matchesTag,
  parseModeParam,
  parseTagsParam,
} from './tagFilter';

describe('matchesTag', () => {
  test('完全一致でヒットする', () => {
    expect(matchesTag('rust', ['rust', 'aws/lambda'])).toBe(true);
  });

  test('祖先マッチでヒットする', () => {
    expect(matchesTag('aws', ['aws/lambda'])).toBe(true);
  });

  test('前方一致だけではヒットしない（aws と awsome）', () => {
    expect(matchesTag('aws', ['awsome'])).toBe(false);
  });

  test('子タグの選択で親タグのみの記事はヒットしない', () => {
    expect(matchesTag('aws/lambda', ['aws'])).toBe(false);
  });
});

describe('buildTagTreeFromFacets', () => {
  test('ルートタグ（tech/misc）を第1階層としてツリーを構築する', () => {
    const facets = [
      { path: 'tech', count: 5 },
      { path: 'tech/aws', count: 3 },
      { path: 'tech/aws/lambda', count: 2 },
      { path: 'misc', count: 2 },
      { path: 'misc/gadget', count: 2 },
    ];
    const tree = buildTagTreeFromFacets(facets);
    expect(tree.map((n) => [n.path, n.count])).toEqual([
      ['tech', 5],
      ['misc', 2],
    ]);
    expect(tree[0].children.map((n) => [n.path, n.count])).toEqual([['tech/aws', 3]]);
    expect(tree[0].children[0].children.map((n) => n.path)).toEqual(['tech/aws/lambda']);
    expect(tree[1].children.map((n) => n.path)).toEqual(['misc/gadget']);
  });

  test('count 降順・path 昇順で並べる', () => {
    const facets = [
      { path: 'rust', count: 5 },
      { path: 'go', count: 5 },
      { path: 'aws', count: 3 },
    ];
    const tree = buildTagTreeFromFacets(facets);
    expect(tree.map((n) => n.path)).toEqual(['go', 'rust', 'aws']);
  });

  test('親がファセットに含まれないパスはルートとして扱う', () => {
    const facets = [
      { path: 'tech/aws', count: 5 },
      { path: 'tech/aws/lambda', count: 3 },
    ];
    const tree = buildTagTreeFromFacets(facets);
    expect(tree).toHaveLength(1);
    expect(tree[0].path).toBe('tech/aws');
    expect(tree[0].children.map((n) => n.path)).toEqual(['tech/aws/lambda']);
  });

  test('ノードの label は末尾セグメントになる', () => {
    const facets = [
      { path: 'tech', count: 3 },
      { path: 'tech/aws', count: 3 },
      { path: 'tech/aws/lambda', count: 3 },
    ];
    const tree = buildTagTreeFromFacets(facets);
    expect(tree[0].label).toBe('tech');
    expect(tree[0].children[0].label).toBe('aws');
    expect(tree[0].children[0].children[0].label).toBe('lambda');
  });

  test('空ファセットは空配列を返す', () => {
    expect(buildTagTreeFromFacets([])).toEqual([]);
  });
});

describe('parseTagsParam / buildFilterQuery', () => {
  test('カンマ区切りをパースし重複と不正パスを除外する', () => {
    expect(parseTagsParam('rust,aws/lambda,rust,,/aws,aws//cdk')).toEqual(['rust', 'aws/lambda']);
  });

  test('null は空配列になる', () => {
    expect(parseTagsParam(null)).toEqual([]);
  });

  test('クエリ文字列とラウンドトリップできる', () => {
    const query = buildFilterQuery(['rust', 'aws/lambda'], 'or');
    expect(query).toBe('?tags=rust,aws%2Flambda&mode=or');
    const params = new URLSearchParams(query);
    expect(parseTagsParam(params.get('tags'))).toEqual(['rust', 'aws/lambda']);
    expect(parseModeParam(params.get('mode'))).toBe('or');
  });

  test('選択なしは空文字、and（デフォルト）または単一選択では mode を省略する', () => {
    expect(buildFilterQuery([], 'or')).toBe('');
    expect(buildFilterQuery(['rust', 'aws'], 'and')).toBe('?tags=rust,aws');
    expect(buildFilterQuery(['rust'], 'or')).toBe('?tags=rust');
  });
});

describe('parseModeParam', () => {
  test('or 以外は and（デフォルト）にフォールバックする', () => {
    expect(parseModeParam('and')).toBe('and');
    expect(parseModeParam('or')).toBe('or');
    expect(parseModeParam('OR')).toBe('and');
    expect(parseModeParam(null)).toBe('and');
  });
});
