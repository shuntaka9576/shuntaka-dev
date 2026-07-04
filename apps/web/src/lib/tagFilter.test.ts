import { describe, expect, test } from 'bun:test';
import {
  buildFilterQuery,
  buildTagTree,
  matchesSelection,
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

describe('matchesSelection', () => {
  const tags = ['rust', 'aws/lambda'];

  test('選択なしは常にヒットする', () => {
    expect(matchesSelection(tags, [], 'or')).toBe(true);
  });

  test('or はいずれかのタグでヒットする', () => {
    expect(matchesSelection(tags, ['rust', 'go'], 'or')).toBe(true);
    expect(matchesSelection(tags, ['go', 'python'], 'or')).toBe(false);
  });

  test('and はすべてのタグを含むときだけヒットする', () => {
    expect(matchesSelection(tags, ['rust', 'aws'], 'and')).toBe(true);
    expect(matchesSelection(tags, ['rust', 'go'], 'and')).toBe(false);
  });
});

describe('buildTagTree', () => {
  test('祖先タグへ件数を合算し件数降順で並べる', () => {
    const tree = buildTagTree([['aws/lambda'], ['aws/cdk'], ['aws/lambda', 'rust'], ['rust']]);
    expect(tree.map((n) => [n.path, n.count])).toEqual([
      ['aws', 3],
      ['rust', 2],
    ]);
    expect(tree[0].children.map((n) => [n.path, n.count])).toEqual([
      ['aws/lambda', 2],
      ['aws/cdk', 1],
    ]);
  });

  test('同一記事内の兄弟タグは親で1件として数える', () => {
    const tree = buildTagTree([['aws/lambda', 'aws/cdk']]);
    expect(tree).toHaveLength(1);
    expect(tree[0].count).toBe(1);
  });

  test('同数はパス昇順で並べる', () => {
    const tree = buildTagTree([['rust', 'go']]);
    expect(tree.map((n) => n.path)).toEqual(['go', 'rust']);
  });

  test('子ノードの label は末尾セグメントになる', () => {
    const tree = buildTagTree([['aws/lambda']]);
    expect(tree[0].children[0].label).toBe('lambda');
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
