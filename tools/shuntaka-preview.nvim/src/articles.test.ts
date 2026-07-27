import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { extractTitle, isPathInDir, listArticles, stripFrontmatter } from './articles.js';

describe('stripFrontmatter', () => {
  test('frontmatter を除去して本文だけ返す (blog-api と同じ切り出し方)', () => {
    const md = '---\ntitle: "T"\ntags:\n  - "a"\n---\n\n# 本文\n';
    expect(stripFrontmatter(md)).toBe('# 本文\n');
  });

  test('frontmatter が無ければそのまま返す', () => {
    expect(stripFrontmatter('# 本文')).toBe('# 本文');
  });

  test('閉じ --- が無ければそのまま返す', () => {
    const md = '---\ntitle: x\n';
    expect(stripFrontmatter(md)).toBe(md);
  });
});

describe('extractTitle', () => {
  test('frontmatter の title を返す (クォートは剥がす)', () => {
    expect(extractTitle('---\ntitle: "タイトル"\npublish: true\n---\n本文')).toBe('タイトル');
  });

  test('クォート無しの title も取れる', () => {
    expect(extractTitle('---\ntitle: plain title\n---\n')).toBe('plain title');
  });

  test('frontmatter が無ければ null', () => {
    expect(extractTitle('# 見出し')).toBeNull();
  });
});

describe('isPathInDir', () => {
  test('配下は true、外や .. 経由は false', () => {
    expect(isPathInDir('/a/b/c.md', '/a/b')).toBe(true);
    expect(isPathInDir('/a/other/c.md', '/a/b')).toBe(false);
    expect(isPathInDir('/a/b/../secret.md', '/a/b')).toBe(false);
  });
});

describe('listArticles', () => {
  test('.md だけを title と日付付きで列挙する', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shuntaka-preview-'));
    writeFileSync(join(dir, 'a.md'), '---\ntitle: "記事A"\n---\n本文');
    writeFileSync(join(dir, 'b.md'), '# タイトル無し');
    writeFileSync(join(dir, 'c.txt'), 'not markdown');

    const entries = listArticles(dir);
    expect(entries.length).toBe(2);

    const a = entries.find((e) => e.name === 'a.md');
    expect(a?.title).toBe('記事A');
    expect(a?.createdAt).toBeGreaterThan(0);
    expect(a?.updatedAt).toBeGreaterThan(0);

    // title の無いファイルは拡張子を除いたファイル名で表示する
    const b = entries.find((e) => e.name === 'b.md');
    expect(b?.title).toBe('b');
  });

  test('存在しないディレクトリは空配列', () => {
    expect(listArticles('/no/such/dir')).toEqual([]);
  });
});
