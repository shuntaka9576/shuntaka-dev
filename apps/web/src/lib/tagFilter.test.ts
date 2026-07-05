import { describe, expect, test } from 'bun:test';
import {
  buildFilterQuery,
  buildTagTreeFromFacets,
  matchesTag,
  parseModeParam,
  parseTagsParam,
  toRelativeTags,
} from './tagFilter';

describe('toRelativeTags', () => {
  test('root プレフィックスを除去する', () => {
    expect(toRelativeTags(['tech/rust', 'tech/aws/lambda'], 'tech')).toEqual([
      'rust',
      'aws/lambda',
    ]);
  });

  test('root 単独タグは除外する', () => {
    expect(toRelativeTags(['tech', 'tech/rust'], 'tech')).toEqual(['rust']);
  });

  test('root が一致しないタグは除外する', () => {
    expect(toRelativeTags(['misc/gadget', 'tech/rust'], 'tech')).toEqual(['rust']);
  });

  test('note タブは misc root で変換する', () => {
    expect(toRelativeTags(['misc/gadget', 'misc/life/travel'], 'misc')).toEqual([
      'gadget',
      'life/travel',
    ]);
  });
});

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
  test('root プレフィックスを除去してツリーを構築する', () => {
    const facets = [
      { path: 'tech/aws', count: 3 },
      { path: 'tech/aws/lambda', count: 2 },
      { path: 'tech/rust', count: 3 },
    ];
    const tree = buildTagTreeFromFacets(facets, 'tech');
    expect(tree.map((n) => [n.path, n.count])).toEqual([
      ['aws', 3],
      ['rust', 3],
    ]);
    expect(tree[0].children.map((n) => [n.path, n.count])).toEqual([['aws/lambda', 2]]);
  });

  test('count 降順・path 昇順で並べる', () => {
    const facets = [
      { path: 'tech/rust', count: 5 },
      { path: 'tech/go', count: 5 },
      { path: 'tech/aws', count: 3 },
    ];
    const tree = buildTagTreeFromFacets(facets, 'tech');
    expect(tree.map((n) => n.path)).toEqual(['go', 'rust', 'aws']);
  });

  test('root が一致しないパスは除外する', () => {
    const facets = [
      { path: 'misc/gadget', count: 2 },
      { path: 'tech/rust', count: 5 },
    ];
    const tree = buildTagTreeFromFacets(facets, 'tech');
    expect(tree).toHaveLength(1);
    expect(tree[0].path).toBe('rust');
  });

  test('3階層のツリーを正しく構築する', () => {
    const facets = [
      { path: 'tech/aws', count: 5 },
      { path: 'tech/aws/lambda', count: 3 },
      { path: 'tech/aws/cdk', count: 2 },
    ];
    const tree = buildTagTreeFromFacets(facets, 'tech');
    expect(tree).toHaveLength(1);
    expect(tree[0].path).toBe('aws');
    expect(tree[0].count).toBe(5);
    expect(tree[0].children.map((n) => [n.path, n.count])).toEqual([
      ['aws/lambda', 3],
      ['aws/cdk', 2],
    ]);
  });

  test('子ノードの label は末尾セグメントになる', () => {
    const facets = [
      { path: 'tech/aws', count: 3 },
      { path: 'tech/aws/lambda', count: 3 },
    ];
    const tree = buildTagTreeFromFacets(facets, 'tech');
    expect(tree[0].label).toBe('aws');
    expect(tree[0].children[0].label).toBe('lambda');
  });

  test('空ファセットは空配列を返す', () => {
    expect(buildTagTreeFromFacets([], 'tech')).toEqual([]);
  });

  test('root 配下のパスがなければ空配列を返す', () => {
    const facets = [{ path: 'misc/gadget', count: 2 }];
    expect(buildTagTreeFromFacets(facets, 'tech')).toEqual([]);
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
