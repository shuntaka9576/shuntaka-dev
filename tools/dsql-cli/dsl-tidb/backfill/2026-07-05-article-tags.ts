#!/usr/bin/env bun
/**
 * 既存記事へのタグ付与ワンショットスクリプト（2026-07-05 article-tags タスク）
 *
 * 1. article リポジトリの frontmatter を更新する
 *    - 全 .md から `category: []` 行を削除
 *    - MAPPING にある記事へ `tags:` を追記（既に tags がある場合はスキップして警告）
 * 2. backfill SQL（同ディレクトリの 2026-07-05-article-tags.sql）を生成する
 *    - slug ベース・INSERT IGNORE の冪等 SQL。blog_dev / blog_prd 共用
 *
 * 使い方:
 *   bun tools/dsql-cli/dsl-tidb/backfill/2026-07-05-article-tags.ts            # dry-run (SQL 生成のみ)
 *   bun tools/dsql-cli/dsl-tidb/backfill/2026-07-05-article-tags.ts --apply    # frontmatter も書き換える
 *
 * article リポジトリの場所は ARTICLES_DIR 環境変数で上書き可能。
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ARTICLES_DIR =
  process.env.ARTICLES_DIR ?? '/Users/shuntaka/repos/github.com/shuntaka-dev/article/articles';
const SQL_OUT = join(import.meta.dir, '2026-07-05-article-tags.sql');
const APPLY = process.argv.includes('--apply');

// タクソノミー: ルートは tech / misc の2つ（最大3階層）
// slug → フルパス表記のタグ一覧
const MAPPING: Record<string, string[]> = {
  '01esxf9w62kx10wfbg8888pqrp': ['tech/next.js', 'tech/react', 'tech/aws/dynamodb'],
  '01etqfnfw9h98gffzbqsv4r32w': ['misc/振り返り', 'tech/neovim', 'tech/next.js', 'tech/go'],
  '01ev3p1knggn1wwsg0n0e98915': ['tech/typescript', 'tech/npm', 'tech/モノレポ'],
  '01evbw029qzxavp20erstgvm5r': ['tech/typescript', 'tech/npm', 'tech/モノレポ'],
  '01ezm5k2rt1jm6zbsewm33r0xw': ['tech/github', 'tech/oauth', 'tech/typescript'],
  '01f07hctzhjcwtdq4h6ew9stk8': [
    'tech/next.js',
    'tech/aws/lambda',
    'tech/aws/dynamodb',
    'tech/github',
  ],
  '01f0n3x0afc5wt54qeaz77zvw4': ['tech/neovim', 'tech/typescript', 'tech/開発環境'],
  '01f2wwqs2jcdgc7fh8bmhnewk6': ['tech/gcp', 'tech/next.js', 'tech/cdn'],
  '01f3qsp7vz8dtetg5cq27ercna': ['tech/next.js', 'tech/react', 'tech/typescript'],
  '01f4gnep6herhgy449er48g9c0': ['tech/iot', 'tech/aws', 'tech/mqtt', 'tech/セキュリティ'],
  '01f4xw3pwm7tcrdswyzqsft5zs': ['tech/セキュリティ', 'tech/jwt', 'tech/oauth'],
  '01fcexkj03t5wr0hkjt37t7dcz': ['tech/cloudflare', 'tech/dns'],
  '01fcg0jjyv4qmhg4n8r9hmcfds': ['tech/cloudflare', 'tech/dns', 'tech/cli'],
  '01fe7z6p0rwwyjq90gkgcbm9nc': ['misc'],
  '01ffj5r74ykepbn4ae7eymdzs1': ['tech/iot', 'tech/aws', 'tech/arduino', 'tech/開発環境'],
  '01ffwa0x782te58803721b1czg': ['tech/neovim', 'tech/arduino', 'tech/開発環境'],
  '01fg0ayqeqbf4rbfzc7gev1t0k': ['tech/iot', 'tech/arduino', 'tech/開発環境'],
  '01fgdc0bawyb6d34gs54vxgpg9': ['tech/iot', 'tech/aws', 'tech/arduino', 'tech/mqtt'],
  '01fhkmja03z60ty39pkjnhv1e5': ['tech/typescript', 'tech/github', 'tech/cli'],
  '01fmzy00fzvq736j42pa1jgnm5': ['tech/deepl', 'tech/cli'],
  '01fppard9e05j9j9q6mh7w91pr': ['tech/rust', 'tech/wasm', 'tech/npm', 'tech/モノレポ'],
  '01fqn7vgp6hcejnyhe6k0fs208': ['misc/振り返り', 'tech/neovim', 'tech/iot'],
  '01fqtbggce9a5g9efzf83rvydy': ['tech/figma', 'tech/開発環境'],
  '01ftj8hr48t31sea0ed6vkzvhw': ['tech/tailwindcss', 'tech/css', 'tech/react'],
  '01fvkbeq00ejdq4xe38a7ccfb0': ['tech/react', 'tech/tailwindcss'],
  '01fvpj77522jpcagxsget1ejqr': [
    'tech/oauth',
    'tech/cloudflare',
    'tech/セキュリティ',
    'tech/typescript',
  ],
  '01g19p2b2eg3dmjfzj4qg7cywp': ['tech/go', 'tech/イベント参加'],
  '01g7kk2jy54b9d7ct876mexwkm': ['tech/neovim', 'tech/zig', 'tech/typescript', 'tech/開発環境'],
  '01g83dwsgvzecbjq0vjfbfyma3': ['tech/zig', 'tech/開発環境'],
  '01gmj0rnrsx2rwsqyfj2m15ymb': ['misc/振り返り', 'tech/go', 'tech/neovim', 'tech/登壇'],
  '01h58x6g51p3p0dekcxdg39cm6': ['tech/イベント参加', 'misc/キャリア'],
  '01h5eh62nbyxx8azf4nxsv350q': ['tech/イベント参加', 'misc'],
  '20230717-lean-devops': ['tech/開発生産性', 'tech/devops', 'misc/読書'],
  '20230718-tokyo-walking': ['misc/散歩'],
  '20230901-translate-cdk-developers-guide': ['tech/aws/cdk', 'misc/読書'],
  '20230902-drive-memo': ['misc'],
  '20230908-js-runtime': ['tech/javascript', 'tech/node.js', 'tech/deno'],
  '20230915-wasm-night-11': ['tech/wasm', 'tech/イベント参加'],
  '20231014-rust-error-list': ['tech/rust', 'tech/開発環境'],
  '20231023-defes-matome': ['tech/deno', 'tech/javascript', 'tech/イベント参加'],
  '20231118-vim-conf': ['tech/neovim', 'tech/denops', 'tech/イベント参加'],
  '20231224-refleting-on-2023': ['misc/振り返り', 'tech/登壇', 'misc/キャリア'],
  '20240205-snow-day-warn': ['misc'],
  '20240206-learn-shutoko': ['misc'],
  '20240211-ready-happy-wedding': ['misc'],
  '20240212-youtube-best-practice': ['misc/youtube'],
  '20240506-cloudinary-turai': ['tech/cloudinary', 'tech/aws/s3'],
  '20240511-tskaigi-report': ['tech/typescript', 'tech/イベント参加'],
  '20240531-plum-wine': ['misc/料理'],
  '20240722-insights-gained-from-public-speaking': ['misc/振り返り', 'misc/キャリア'],
  '20240904-hiltukoshi': ['misc/引っ越し'],
  '20240914-hiltukoshi-2': ['misc/引っ越し'],
  '20240930-confirm-family-comms-in-writing': ['misc/コミュニケーション'],
  '20241115-ponponpain': ['misc/健康'],
  '20241201-study-programming': ['tech/rust', 'tech/neovim', 'misc/キャリア', 'tech/nix'],
  '20241224-refleting-on-2024': [
    'misc/振り返り',
    'tech/登壇',
    'misc/キャリア',
    'tech/raspberry-pi',
    'tech/kubernetes',
  ],
  '20241224-tech-poem': ['tech/rust', 'tech/wasm', 'misc/キャリア'],
  '20250104-tech-poem': ['misc', 'tech/nix', 'tech/rust', 'tech/開発環境'],
  '20250106-tech-poem': ['misc', 'tech/nix', 'tech/開発環境'],
  '20250107-tech-poem': ['misc/キャリア'],
  '20250108-poem': ['misc'],
  '20250109-tech-poem': ['misc/キャリア'],
  '20250114-poem': ['misc/キャリア'],
  '20250115-async-runtime': ['tech/rust', 'tech/go', 'tech/node.js', 'tech/技術メモ'],
  '20250116-poem': ['misc'],
  '20250116-poem2': ['misc'],
  '20250124-poem': ['misc/キャリア'],
  '2025022-tech-poem': ['tech/aws', 'tech/技術メモ'],
  '20250302-poem': ['misc/振り返り', 'tech/rust', 'tech/mcp', 'misc/キャリア'],
  '20250303-tech-poem': ['misc', 'tech/技術メモ'],
  '20250411-poem': ['misc/振り返り', 'tech/mcp', 'misc/キャリア'],
  '20250615-plum-wine': ['misc/料理'],
  '20250809-poem': ['misc/振り返り', 'misc/キャリア'],
  '20251101-poem': ['misc'],
  '20251224-reflecting-on-2025': ['misc/振り返り', 'tech/rust', 'tech/mcp', 'misc/キャリア'],
  '20260108-shuntaka-blog-rearchitecture': [
    'tech/rust',
    'tech/aws/lambda',
    'tech/next.js',
    'tech/aws/cdk',
    'tech/postgresql',
  ],
  '20260117-poem': ['tech/開発環境', 'tech/rust', 'misc/キャリア'],
  '20260118-transfer-from-cloudflare': ['tech/cloudflare', 'tech/aws', 'tech/開発環境'],
  '20260125-poem': ['misc/キャリア'],
  '20260201-poem': ['misc/振り返り', 'tech/bun', 'misc/キャリア'],
  '20260215-apple-developer': ['tech/開発環境', 'tech/macos', 'tech/tauri'],
  '20260301-poem': ['misc/振り返り', 'tech/tauri', 'misc/キャリア', 'tech/登壇'],
  '20260315-poem': ['misc/キャリア', 'tech/技術メモ', 'tech/開発環境'],
  '20260321-opencode-composer-2': ['tech/開発環境', 'tech/技術メモ'],
  '20260401-poem': ['misc/振り返り', 'tech/tauri', 'tech/rust', 'misc/キャリア'],
  '20260501-poem': ['misc/振り返り', 'tech/tauri', 'misc/キャリア'],
  '20260601-poem': ['misc/振り返り', 'tech/github-actions', 'tech/tauri', 'misc/キャリア'],
  'vim-conf-2024': ['tech/neovim', 'tech/イベント参加', 'tech/開発環境'],
  'vim-conf-2025': ['tech/neovim', 'tech/イベント参加', 'tech/開発環境'],
  // 下書き（publish: false）。公開時に webhook で同期される想定で frontmatter にだけ入れておく
  '20250614-2025fp-matsuri': ['tech/イベント参加', 'tech/関数型プログラミング'],
  '20260630-tidb-blog-query-tuning': ['tech/tidb', 'tech/技術メモ'],
};

// --- バリデーション ---------------------------------------------------------

const errors: string[] = [];
// leaf 名はグローバル一意 (uq_tags_name) なので、同じ leaf が別パスに現れたらエラー
const leafToPath = new Map<string, string>();
// 同名ノードが別の親に現れたらエラー（例: tech/aws と misc/aws）
const nodeParent = new Map<string, string | null>();

for (const [slug, tags] of Object.entries(MAPPING)) {
  for (const tag of tags) {
    const segments = tag.split('/');
    if (segments.length > 3) errors.push(`4階層以上: ${slug} ${tag}`);
    if (segments.some((s) => s !== s.trim() || s === '')) {
      errors.push(`空セグメント/余白: ${slug} ${tag}`);
    }
    const leaf = segments[segments.length - 1];
    const known = leafToPath.get(leaf);
    if (known && known !== tag) errors.push(`leaf 重複: ${tag} vs ${known}`);
    if (!known) leafToPath.set(leaf, tag);
    segments.forEach((name, i) => {
      const parent = i === 0 ? null : segments[i - 1];
      const knownParent = nodeParent.get(name);
      if (knownParent !== undefined && knownParent !== parent) {
        errors.push(`同名タグの親が不一致: ${name} (${knownParent} vs ${parent})`);
      }
      nodeParent.set(name, parent);
    });
  }
}

const files = readdirSync(ARTICLES_DIR).filter((f) => f.endsWith('.md'));
const slugs = new Set(files.map((f) => f.replace(/\.md$/, '')));
for (const slug of Object.keys(MAPPING)) {
  if (!slugs.has(slug)) errors.push(`ファイルが存在しない: ${slug}.md`);
}

if (errors.length > 0) {
  console.error('バリデーションエラー:');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

// --- 1. frontmatter 更新 ----------------------------------------------------

let categoryRemoved = 0;
let tagsAdded = 0;
const warnings: string[] = [];

for (const file of files) {
  const slug = file.replace(/\.md$/, '');
  const path = join(ARTICLES_DIR, file);
  const lines = readFileSync(path, 'utf8').split('\n');

  if (lines[0].trim() !== '---') {
    warnings.push(`frontmatter なし: ${file}`);
    continue;
  }
  const end = lines.indexOf('---', 1);
  if (end === -1) {
    warnings.push(`frontmatter が閉じていない: ${file}`);
    continue;
  }

  let fm = lines.slice(1, end);
  const beforeLen = fm.length;
  fm = fm.filter((l) => l.trim() !== 'category: []');
  const removed = beforeLen - fm.length;

  const tags = MAPPING[slug];
  let added = false;
  if (tags) {
    if (fm.some((l) => l.startsWith('tags:'))) {
      warnings.push(`tags が既に存在するためスキップ: ${file}`);
    } else {
      fm.push('tags:');
      for (const t of tags) fm.push(`  - "${t}"`);
      added = true;
    }
  }

  if (removed === 0 && !added) continue;
  categoryRemoved += removed;
  if (added) tagsAdded += 1;

  if (APPLY) {
    writeFileSync(path, ['---', ...fm, '---', ...lines.slice(end + 1)].join('\n'));
  }
}

// --- 2. backfill SQL 生成 ---------------------------------------------------

const esc = (s: string) => s.replaceAll("'", "''");

// 全パスのプレフィックスからノード一覧を階層順に組み立てる
const nodesByLevel: Map<string, string | null>[] = [new Map(), new Map(), new Map()];
for (const tags of Object.values(MAPPING)) {
  for (const tag of tags) {
    const segments = tag.split('/');
    segments.forEach((name, i) => {
      nodesByLevel[i].set(name, i === 0 ? null : segments[i - 1]);
    });
  }
}

const sql: string[] = [];
sql.push('-- 既存記事へのタグ付与 backfill SQL（2026-07-05 article-tags タスク）');
sql.push(`-- 生成元: ${import.meta.file}（MAPPING が正）。手で編集しない`);
sql.push('-- 冪等 (INSERT IGNORE)。slug ベースなので blog_dev / blog_prd 共用。');
sql.push(
  '-- 適用: mysql -h tidb.$TAILNET -P 4000 -u root -D $SCHEMA < 2026-07-05-article-tags.sql',
);
sql.push('');
sql.push('-- 1. ルートタグ');
sql.push(
  `INSERT IGNORE INTO tags (name) VALUES ${[...nodesByLevel[0].keys()]
    .map((n) => `('${esc(n)}')`)
    .join(', ')};`,
);
for (const level of [1, 2]) {
  if (nodesByLevel[level].size === 0) continue;
  sql.push('');
  sql.push(`-- ${level + 1}. ${level + 1}階層目のタグ（親を逆引きして紐付け）`);
  for (const [name, parent] of nodesByLevel[level]) {
    sql.push(
      `INSERT IGNORE INTO tags (name, parent_tag_id)\n` +
        `  SELECT '${esc(name)}', tag_id FROM tags WHERE name = '${esc(parent!)}';`,
    );
  }
}
sql.push('');
sql.push('-- 4. 記事とタグの関連（leaf のみに張る。slug が無い環境では 0 行 insert）');
for (const [slug, tags] of Object.entries(MAPPING)) {
  const leaves = tags.map((t) => t.split('/').at(-1)!);
  sql.push(`-- ${slug}: ${tags.join(', ')}`);
  sql.push(
    `INSERT IGNORE INTO articles_tags (article_id, tag_id)\n` +
      `  SELECT a.article_id, t.tag_id\n` +
      `  FROM articles a JOIN tags t ON t.name IN (${leaves.map((l) => `'${esc(l)}'`).join(', ')})\n` +
      `  WHERE a.slug = '${esc(slug)}';`,
  );
}
sql.push('');
sql.push('-- 検証用クエリ');
sql.push(
  '-- SELECT t.name, COUNT(*) FROM tags t JOIN articles_tags at2 ON t.tag_id = at2.tag_id GROUP BY t.name ORDER BY COUNT(*) DESC;',
);
sql.push(
  "-- SELECT COUNT(*) FROM articles a WHERE a.status = 'published' AND NOT EXISTS (SELECT 1 FROM articles_tags at2 WHERE at2.article_id = a.article_id);",
);

writeFileSync(SQL_OUT, sql.join('\n') + '\n');

// --- サマリ -----------------------------------------------------------------

for (const w of warnings) console.warn(`WARN: ${w}`);
console.log(`mode:              ${APPLY ? 'apply' : 'dry-run (frontmatter 未変更)'}`);
console.log(`記事ファイル:      ${files.length}`);
console.log(`category 削除行:   ${categoryRemoved}`);
console.log(`tags 追記対象:     ${tagsAdded} / ${Object.keys(MAPPING).length}`);
console.log(
  `タグノード数:      root=${nodesByLevel[0].size} L2=${nodesByLevel[1].size} L3=${nodesByLevel[2].size}`,
);
console.log(`SQL 出力:          ${SQL_OUT}`);
