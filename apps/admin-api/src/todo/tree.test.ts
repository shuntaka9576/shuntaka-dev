import { describe, expect, it } from 'bun:test';
import { collectDescendantIds } from './tree.js';

describe('collectDescendantIds', () => {
  it('指定項目と、その子・孫だけを返す', () => {
    const ids = collectDescendantIds(
      [
        { id: 'root', parentId: null },
        { id: 'child', parentId: 'root' },
        { id: 'grandchild', parentId: 'child' },
        { id: 'sibling', parentId: null },
      ],
      'root',
    );
    expect(new Set(ids)).toEqual(new Set(['root', 'child', 'grandchild']));
  });
});
