import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

export type ArticleEntry = {
  path: string;
  name: string;
  title: string;
  createdAt: number; // epoch ms (初回コミット日時。git 管理外はファイルの birthtime)
  updatedAt: number; // epoch ms (最終コミット日時。git 管理外はファイルの mtime)
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

// git log を 1 回だけ流して、dir 配下の各ファイルの最終コミット (updated) と
// 初回コミット (created) の日時を集める。mtime/birthtime は clone や checkout でも
// 変わってノイズになるため、git 管理下では常にコミット日時を使う。
// git リポジトリでなければ null (呼び出し側でファイルシステムの日時にフォールバック)
export function gitTimes(
  dir: string,
): Map<string, { createdAt: number; updatedAt: number }> | null {
  try {
    const opts: ExecFileSyncOptionsWithStringEncoding = {
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    };
    const root = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], opts).trim();
    // --name-only のパスは repo root 相対。\x01 をコミット日時の行マーカーにする
    const log = execFileSync(
      'git',
      [
        '-C',
        dir,
        '-c',
        'core.quotepath=false',
        'log',
        '--format=%x01%ct',
        '--name-only',
        '--',
        '.',
      ],
      opts,
    );
    const times = new Map<string, { createdAt: number; updatedAt: number }>();
    let commitAt = 0;
    for (const line of log.split('\n')) {
      if (line.startsWith('\x01')) {
        commitAt = Number(line.slice(1)) * 1000;
        continue;
      }
      if (line === '') {
        continue;
      }
      const path = join(root, line);
      const entry = times.get(path);
      if (entry) {
        // log は新しい順なので、後に出るコミットほど古い = created を上書きしていく
        entry.createdAt = commitAt;
      } else {
        times.set(path, { createdAt: commitAt, updatedAt: commitAt });
      }
    }
    return times;
  } catch {
    return null;
  }
}

export function listArticles(dir: string): ArticleEntry[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const committed = gitTimes(dir);
  // git の返すパスは symlink 解決済み (macOS の /var → /private/var 等) のため、
  // ルックアップ用に dir も realpath へ正規化する
  let lookupDir = dir;
  try {
    lookupDir = realpathSync(dir);
  } catch {
    // 解決できなければそのまま
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
      // 未コミットの新規ファイルは git に日時が無いのでファイルシステムの日時を使う
      const times = committed?.get(join(lookupDir, name)) ?? {
        createdAt: Math.round(st.birthtimeMs || st.ctimeMs),
        updatedAt: Math.round(st.mtimeMs),
      };
      entries.push({
        path,
        name,
        title: extractTitle(text) ?? name.replace(/\.md$/, ''),
        createdAt: times.createdAt,
        updatedAt: times.updatedAt,
      });
    } catch {
      // 読めないファイルは一覧から外す
    }
  }
  return entries;
}
