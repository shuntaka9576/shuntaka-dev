import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

export type ArticleEntry = {
  path: string;
  name: string;
  title: string;
  createdAt: number; // epoch ms (birthtime)
  updatedAt: number; // epoch ms (mtime)
};

// blog-api の ArticleFrontmatter::parse と同じ切り出し方（先頭 --- 〜 \n---）で
// frontmatter を除去する。本番は frontmatter を落としてから Markdown 変換するため、
// プレビューも同じにする。frontmatter が無ければそのまま返す
export function stripFrontmatter(markdown: string): string {
  const trimmed = markdown.trimStart();
  if (!trimmed.startsWith('---')) {
    return markdown;
  }
  const rest = trimmed.slice(3);
  const end = rest.indexOf('\n---');
  if (end === -1) {
    return markdown;
  }
  return rest.slice(end + 4).trimStart();
}

// 記事一覧の表示名。記事ファイル名は ULID なので frontmatter の title を使う
export function extractTitle(markdown: string): string | null {
  const trimmed = markdown.trimStart();
  if (!trimmed.startsWith('---')) {
    return null;
  }
  const rest = trimmed.slice(3);
  const end = rest.indexOf('\n---');
  if (end === -1) {
    return null;
  }
  const matched = rest.slice(0, end).match(/^title:\s*["']?(.*?)["']?\s*$/m);
  return matched?.[1] ? matched[1] : null;
}

// ブラウザから渡された path が記事ディレクトリ配下かの検証（ディレクトリトラバーサル防止）
export function isPathInDir(path: string, dir: string): boolean {
  return resolve(path).startsWith(resolve(dir) + sep);
}

export function listArticles(dir: string): ArticleEntry[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const entries: ArticleEntry[] = [];
  for (const name of names) {
    if (!name.endsWith('.md')) {
      continue;
    }
    const path = join(dir, name);
    try {
      const st = statSync(path);
      if (!st.isFile()) {
        continue;
      }
      const text = readFileSync(path, 'utf-8');
      entries.push({
        path,
        name,
        title: extractTitle(text) ?? name.replace(/\.md$/, ''),
        createdAt: Math.round(st.birthtimeMs || st.ctimeMs),
        updatedAt: Math.round(st.mtimeMs),
      });
    } catch {
      // 読めないファイルは一覧から外す
    }
  }
  return entries;
}
