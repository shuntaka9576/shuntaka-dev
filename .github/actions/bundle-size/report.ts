/**
 * Turbopack の route-bundle-stats.json (TURBOPACK_STATS=1 で生成) を 2 つ比較し、
 * PR コメント用の Markdown を stdout に出力する。
 *
 * ほぼ全ての JS は全ルート共有のチャンクなので、「共有 JS + 合計」の概要と
 * 「ルートが共有分の上に追加で読む JS」の 2 表に分けて出す。
 *
 * usage: bun .github/actions/bundle-size/report.ts <base-stats.json> <pr-stats.json>
 */

import { dirname, join } from 'node:path';

interface RouteStat {
  route: string;
  firstLoadUncompressedJsBytes: number;
  firstLoadChunkPaths?: string[];
}

interface SideData {
  /** route → first-load 合計 (stats JSON の値) */
  firstLoad: Map<string, number>;
  /** route → 共有分を除いたルート固有チャンクの実ファイル合計 */
  routeOnly: Map<string, number>;
  /** 全ルートの first-load に含まれる共有チャンクの実ファイル合計 */
  sharedBytes: number;
  /** 全ルートのユニークチャンク実ファイル合計 */
  totalBytes: number;
}

// 1 KiB 未満の変動はノイズとみなす。🔴 は明確なリグレッション検知用
const NOISE_BYTES = 1024;
const ALERT_BYTES = 50 * 1024;

const COMMENT_MARKER = '<!-- bundle-size-report -->';

function formatKiB(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

function diffCell(baseBytes: number, prBytes: number): { emoji: string; text: string } {
  const delta = prBytes - baseBytes;
  let emoji = '⚪';
  if (delta >= ALERT_BYTES) {
    emoji = '🔴';
  } else if (delta >= NOISE_BYTES) {
    emoji = '🟡';
  } else if (delta <= -NOISE_BYTES) {
    emoji = '🟢';
  }
  if (Math.abs(delta) < NOISE_BYTES) {
    return { emoji, text: '—' };
  }
  const sign = delta >= 0 ? '+' : '';
  const pct = baseBytes > 0 ? ` (${sign}${((delta / baseBytes) * 100).toFixed(1)}%)` : '';
  return { emoji, text: `${sign}${formatKiB(delta)}${pct}` };
}

/**
 * stats JSON を読み、チャンク実ファイルのサイズから共有分・ルート固有分を算出する。
 * チャンクパスは ".next/static/chunks/..." 形式なので、stats JSON の位置
 * (<root>/.next/diagnostics/route-bundle-stats.json) から <root> を逆算して解決する。
 */
async function loadSide(statsPath: string): Promise<SideData> {
  const stats = (await Bun.file(statsPath).json()) as RouteStat[];
  const root = join(dirname(statsPath), '..', '..');

  const sizeCache = new Map<string, number>();
  async function chunkSize(chunkPath: string): Promise<number> {
    const cached = sizeCache.get(chunkPath);
    if (cached !== undefined) return cached;
    const file = Bun.file(join(root, chunkPath));
    const size = (await file.exists()) ? file.size : 0;
    sizeCache.set(chunkPath, size);
    return size;
  }

  const chunkSets = stats.map((s) => new Set(s.firstLoadChunkPaths ?? []));
  const shared = chunkSets.reduce(
    (acc, set) => new Set([...acc].filter((p) => set.has(p))),
    chunkSets[0] ?? new Set<string>(),
  );
  const unique = new Set(chunkSets.flatMap((set) => [...set]));

  let sharedBytes = 0;
  for (const p of shared) sharedBytes += await chunkSize(p);
  let totalBytes = 0;
  for (const p of unique) totalBytes += await chunkSize(p);

  const firstLoad = new Map<string, number>();
  const routeOnly = new Map<string, number>();
  for (const s of stats) {
    firstLoad.set(s.route, s.firstLoadUncompressedJsBytes);
    let own = 0;
    for (const p of s.firstLoadChunkPaths ?? []) {
      if (!shared.has(p)) own += await chunkSize(p);
    }
    routeOnly.set(s.route, own);
  }

  return { firstLoad, routeOnly, sharedBytes, totalBytes };
}

const [basePath, prPath] = process.argv.slice(2);
if (!basePath || !prPath) {
  console.error('usage: bun report.ts <base-stats.json> <pr-stats.json>');
  process.exit(1);
}

const base = await loadSide(basePath);
const pr = await loadSide(prPath);
const routes = [...new Set([...base.firstLoad.keys(), ...pr.firstLoad.keys()])].sort();

// チャンク実ファイルが見つからない場合 (ローカルで JSON だけ渡した等) は
// 共有/固有の分解ができないため first-load 表にフォールバックする
const splitAvailable = base.totalBytes > 0 && pr.totalBytes > 0;

const lines: string[] = [COMMENT_MARKER, '### 📦 Bundle Size (uncompressed)', ''];

if (splitAvailable) {
  const sharedDiff = diffCell(base.sharedBytes, pr.sharedBytes);
  const totalDiff = diffCell(base.totalBytes, pr.totalBytes);
  lines.push(
    '| | Base | PR | Diff |',
    '| --- | ---: | ---: | ---: |',
    `| ${sharedDiff.emoji} **Shared JS** (loaded on every route) | ${formatKiB(base.sharedBytes)} | ${formatKiB(pr.sharedBytes)} | ${sharedDiff.text} |`,
    `| ${totalDiff.emoji} **Total unique JS** | ${formatKiB(base.totalBytes)} | ${formatKiB(pr.totalBytes)} | ${totalDiff.text} |`,
    '',
    '| Route (JS added on top of shared) | Base | PR | Diff |',
    '| --- | ---: | ---: | ---: |',
  );
  for (const route of routes) {
    const baseBytes = base.routeOnly.get(route);
    const prBytes = pr.routeOnly.get(route);
    if (baseBytes === undefined && prBytes !== undefined) {
      lines.push(`| 🆕 \`${route}\` | — | ${formatKiB(prBytes)} | — |`);
    } else if (baseBytes !== undefined && prBytes === undefined) {
      lines.push(`| 🗑️ \`${route}\` | ${formatKiB(baseBytes)} | — | — |`);
    } else if (baseBytes !== undefined && prBytes !== undefined) {
      const d = diffCell(baseBytes, prBytes);
      lines.push(
        `| ${d.emoji} \`${route}\` | ${formatKiB(baseBytes)} | ${formatKiB(prBytes)} | ${d.text} |`,
      );
    }
  }
} else {
  lines.push('| Route (First Load JS) | Base | PR | Diff |', '| --- | ---: | ---: | ---: |');
  for (const route of routes) {
    const baseBytes = base.firstLoad.get(route);
    const prBytes = pr.firstLoad.get(route);
    if (baseBytes === undefined && prBytes !== undefined) {
      lines.push(`| 🆕 \`${route}\` | — | ${formatKiB(prBytes)} | — |`);
    } else if (baseBytes !== undefined && prBytes === undefined) {
      lines.push(`| 🗑️ \`${route}\` | ${formatKiB(baseBytes)} | — | — |`);
    } else if (baseBytes !== undefined && prBytes !== undefined) {
      const d = diffCell(baseBytes, prBytes);
      lines.push(
        `| ${d.emoji} \`${route}\` | ${formatKiB(baseBytes)} | ${formatKiB(prBytes)} | ${d.text} |`,
      );
    }
  }
}

// GitHub が Markdown 中の Mermaid をレンダリングするのを利用して棒グラフで可視化する
const chartRoutes = routes.filter((route) => pr.firstLoad.has(route));
const chartValues = chartRoutes.map((route) =>
  splitAvailable ? (pr.routeOnly.get(route) ?? 0) : (pr.firstLoad.get(route) ?? 0),
);
lines.push(
  '',
  '```mermaid',
  'xychart-beta',
  `    title "${splitAvailable ? 'Route-specific JS (KiB)' : 'First Load JS (KiB)'}"`,
  `    x-axis [${chartRoutes.map((route) => `"${route}"`).join(', ')}]`,
  '    y-axis "KiB"',
  `    bar [${chartValues.map((v) => (v / 1024).toFixed(1)).join(', ')}]`,
  '```',
);

// treemap-beta は GitHub 側の Mermaid バージョン次第。未対応でもコードブロック表示に
// 落ちるだけなので details に畳んで載せる
if (splitAvailable) {
  const treemapRoutes = routes.filter((route) => (pr.routeOnly.get(route) ?? 0) >= 102);
  lines.push(
    '',
    '<details><summary>📐 Treemap (share of total unique JS, KiB)</summary>',
    '',
    '```mermaid',
    'treemap-beta',
    '"Total unique JS"',
    `    "Shared (every route)": ${(pr.sharedBytes / 1024).toFixed(1)}`,
    '    "Route-specific"',
    ...treemapRoutes.map(
      (route) => `        "${route}": ${((pr.routeOnly.get(route) ?? 0) / 1024).toFixed(1)}`,
    ),
    '```',
    '',
    '</details>',
  );
}

lines.push(
  '',
  `> 🔴 ≥ +${formatKiB(ALERT_BYTES)} / 🟡 increased / 🟢 decreased / ⚪ within ±${formatKiB(NOISE_BYTES)}.`,
  "> Calculated from Turbopack's `route-bundle-stats.json` (uncompressed).",
);

console.log(lines.join('\n'));
