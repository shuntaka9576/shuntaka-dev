import { describe, expect, it } from 'bun:test';
import { HTTPException } from 'hono/http-exception';
import { validateTemplateItems } from './templates.js';

describe('validateTemplateItems', () => {
  it('同じ period の階層を許可する', () => {
    expect(() =>
      validateTemplateItems([
        { key: 'a', parentKey: null, period: 'morning', title: '親', position: 0 },
        { key: 'b', parentKey: 'a', period: 'morning', title: '子', position: 1 },
      ]),
    ).not.toThrow();
  });

  it('循環を拒否する', () => {
    expect(() =>
      validateTemplateItems([
        { key: 'a', parentKey: 'b', period: 'morning', title: 'a', position: 0 },
        { key: 'b', parentKey: 'a', period: 'morning', title: 'b', position: 1 },
      ]),
    ).toThrow(HTTPException);
  });
});
