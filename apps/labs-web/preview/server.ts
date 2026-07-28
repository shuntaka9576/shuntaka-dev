// ローカル執筆プレビュー用モック API。
// 本実装の admin-api (GET /api/labs...) と同じレスポンス契約で、
// lab-contents リポジトリのローカルチェックアウトを markdown-wasm
// （ブログと同一レンダラー）で変換して返す。画像は /lab-assets/* で配信し、
// 本番の CloudFront パス構造を再現する。DB・GitHub 同期なしで mdx を執筆確認できる。
/// <reference types="bun" />
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { Hono } from 'hono';
import { fetchResources, loadWasm } from 'markdown-wasm';
import { parse as parseYaml } from 'yaml';

// コンテンツは lab-contents-dev のローカルチェックアウトを参照する
// （モノレポにはコンテンツ・画像を置かない）。LAB_CONTENTS_DIR で上書き可
const CONTENTS_ROOT = process.env.LAB_CONTENTS_DIR
  ? resolve(process.env.LAB_CONTENTS_DIR)
  : join(homedir(), 'repos/github.com/shuntaka9576/lab-contents-dev');
const CONTENTS_DIR = join(CONTENTS_ROOT, 'labs');
if (!existsSync(CONTENTS_DIR)) {
  console.error(
    `コンテンツディレクトリが見つかりません: ${CONTENTS_DIR}\n` +
      'lab-contents-dev をローカルに用意するか、LAB_CONTENTS_DIR でリポジトリルートを指定してください',
  );
  process.exit(1);
}
// ポートは worktree ごとに .env.local で採番される (scripts/port.sh の labs-api)
const PORT = Number(process.env.LABS_API_PORT ?? 43007);

type LabConfig = {
  title: string;
  summary?: string;
  published?: boolean;
  chapters: string[];
};

type ChapterFile = {
  slug: string;
  title: string;
  position: number;
  path: string;
  mtimeMs: number;
};

type Lab = {
  slug: string;
  title: string;
  summary: string | null;
  published: boolean;
  chapters: ChapterFile[];
  updatedAt: string;
};

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

async function readChapterFile(labDir: string, slug: string): Promise<ChapterFile | null> {
  for (const ext of ['.mdx', '.md']) {
    const path = join(labDir, `${slug}${ext}`);
    try {
      const [raw, s] = await Promise.all([readFile(path, 'utf-8'), stat(path)]);
      const fm = raw.match(FRONTMATTER_RE);
      const meta = fm ? (parseYaml(fm[1]) as { title?: string }) : {};
      return { slug, title: meta.title ?? slug, position: 0, path, mtimeMs: s.mtimeMs };
    } catch {
      // 次の拡張子を試す
    }
  }
  console.warn(`chapter file not found: ${labDir}/${slug}.(mdx|md)`);
  return null;
}

async function loadLabs(): Promise<Lab[]> {
  const entries = await readdir(CONTENTS_DIR, { withFileTypes: true });
  const labs: Lab[] = [];
  for (const entry of entries.filter((e) => e.isDirectory())) {
    const labDir = join(CONTENTS_DIR, entry.name);
    const config = parseYaml(await readFile(join(labDir, 'config.yaml'), 'utf-8')) as LabConfig;
    const chapters = (
      await Promise.all(config.chapters.map((slug) => readChapterFile(labDir, slug)))
    ).filter((c): c is ChapterFile => c !== null);
    chapters.forEach((c, i) => {
      c.position = i;
    });
    labs.push({
      slug: entry.name,
      title: config.title,
      summary: config.summary ?? null,
      published: config.published ?? false,
      chapters,
      updatedAt: new Date(Math.max(0, ...chapters.map((c) => c.mtimeMs))).toISOString(),
    });
  }
  return labs.sort((a, b) => a.slug.localeCompare(b.slug));
}

// 本実装の同期処理と同じ書き換え: 章内の相対 images/ 参照を公開 URL に変換
// （プレビューではキャッシュバスターの ?v= は省略）
function rewriteImagePaths(markdown: string, labSlug: string): string {
  return markdown.replace(/(!\[[^\]]*\]\()(?:\.\/)?images\//g, `$1/lab-assets/${labSlug}/images/`);
}

// :::widget 記法 → プレースホルダ div の変換は markdown crate (Rust) 本体が行う
// (packages/markdown-wasm 経由でここでも同じ実装が動く)。JS 側の変換は持たない

const htmlCache = new Map<string, { mtimeMs: number; html: string }>();

async function convertChapter(lab: Lab, chapter: ChapterFile): Promise<string> {
  const cached = htmlCache.get(chapter.path);
  if (cached && cached.mtimeMs === chapter.mtimeMs) {
    return cached.html;
  }
  const raw = await readFile(chapter.path, 'utf-8');
  const markdown = rewriteImagePaths(raw.replace(FRONTMATTER_RE, ''), lab.slug);
  const wasm = await loadWasm();
  const resources = await fetchResources(wasm.collectResourceUrls(markdown));
  const html = wasm.convertMarkdownWithResources(markdown, resources);
  htmlCache.set(chapter.path, { mtimeMs: chapter.mtimeMs, html });
  return html;
}

const toSummary = (lab: Lab) => ({
  slug: lab.slug,
  title: lab.title,
  summary: lab.summary,
  published: lab.published,
  chapterCount: lab.chapters.length,
  updatedAt: lab.updatedAt,
});

const toChapterMeta = ({ slug, title, position }: ChapterFile) => ({ slug, title, position });

const app = new Hono();

app.get('/api/labs', async (c) => {
  const labs = await loadLabs();
  return c.json({ labs: labs.map(toSummary) });
});

app.get('/api/labs/:labSlug', async (c) => {
  const lab = (await loadLabs()).find((l) => l.slug === c.req.param('labSlug'));
  if (!lab) return c.json({ error: 'not found' }, 404);
  return c.json({ lab: toSummary(lab), chapters: lab.chapters.map(toChapterMeta) });
});

app.get('/api/labs/:labSlug/chapters/:chapterSlug', async (c) => {
  const lab = (await loadLabs()).find((l) => l.slug === c.req.param('labSlug'));
  const chapter = lab?.chapters.find((ch) => ch.slug === c.req.param('chapterSlug'));
  if (!lab || !chapter) return c.json({ error: 'not found' }, 404);
  const contentHtml = await convertChapter(lab, chapter);
  return c.json({
    lab: toSummary(lab),
    chapters: lab.chapters.map(toChapterMeta),
    chapter: { ...toChapterMeta(chapter), contentHtml },
  });
});

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

// /lab-assets/<labSlug>/images/... → contents/labs/<labSlug>/images/...
app.get('/lab-assets/*', async (c) => {
  const rel = normalize(decodeURIComponent(c.req.path.replace('/lab-assets/', '')));
  if (rel.startsWith('..')) return c.text('forbidden', 403);
  const file = Bun.file(join(CONTENTS_DIR, rel));
  if (!(await file.exists())) return c.text('not found', 404);
  return new Response(file, {
    headers: { 'Content-Type': MIME[extname(rel)] ?? 'application/octet-stream' },
  });
});

console.log(`labs preview api: http://localhost:${PORT}`);
Bun.serve({ port: PORT, fetch: app.fetch });
