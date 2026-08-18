import { describe, expect, it } from 'bun:test';
import { parseChecklistMarkdown } from './checklist-markdown';

describe('parseChecklistMarkdown', () => {
  it('全角中点とインデントを階層へ変換し、規約は登録しない', () => {
    const result = parseChecklistMarkdown(`# 朝
・親
　・子
# 寝る前
- 就寝前
# 規約
- 保存しない`);
    expect(result.map(({ period, title, parentKey }) => ({ period, title, parentKey }))).toEqual([
      { period: 'morning', title: '親', parentKey: null },
      { period: 'morning', title: '子', parentKey: 'item-1' },
      { period: 'bedtime', title: '就寝前', parentKey: null },
    ]);
  });
});
