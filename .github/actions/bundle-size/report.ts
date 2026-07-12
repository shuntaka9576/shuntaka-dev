/**
 * Turbopack の route-bundle-stats.json (TURBOPACK_STATS=1 で生成) を 2 つ比較し、
 * PR コメント用の Markdown を stdout に出力する。
 *
 * usage: bun .github/actions/bundle-size/report.ts <base-stats.json> <pr-stats.json>
 */

import { dirname, join } from 'node:path';

interface RouteStat {
  route: string;
  firstLoadUncompressedJsBytes: number;
  firstLoadChunkPaths?: string[];
}

// 1 KiB 未満の変動はノイズとみなす。🔴 は明確なリグレッション検知用
const NOISE_BYTES = 1024;
const ALERT_BYTES = 50 * 1024;

const COMMENT_MARKER = '<!-- bundle-size-report -->';

function formatKiB(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

function formatDiff(delta: number, baseBytes: number): string {
  const sign = delta >= 0 ? '+' : '';
  const pct = baseBytes > 0 ? ` (${sign}${((delta / baseBytes) * 100).toFixed(1)}%)` : '';
  return `${sign}${formatKiB(delta)}${pct}`;
}

async function loadStats(path: string): Promise<Map<string, number>> {
  const stats = (await Bun.file(path).json()) as RouteStat[];
  return new Map(stats.map((s) => [s.route, s.firstLoadUncompressedJsBytes]));
}

/**
 * 全ルートのユニークな first-load チャンクの実ファイルサイズ合計。
 * チャンクパスは ".next/static/chunks/..." 形式なので、stats JSON の位置
 * (<root>/.next/diagnostics/route-bundle-stats.json) から <root> を逆算して解決する。
 */
async function totalUniqueChunkBytes(statsPath: string): Promise<number> {
  const stats = (await Bun.file(statsPath).json()) as RouteStat[];
  const root = join(dirname(statsPath), '..', '..');
  const uniquePaths = new Set(stats.flatMap((s) => s.firstLoadChunkPaths ?? []));
  let total = 0;
  for (const chunkPath of uniquePaths) {
    const file = Bun.file(join(root, chunkPath));
    if (await file.exists()) {
      total += file.size;
    }
  }
  return total;
}

const [basePath, prPath] = process.argv.slice(2);
if (!basePath || !prPath) {
  console.error('usage: bun bundle-size-report.ts <base-stats.json> <pr-stats.json>');
  process.exit(1);
}

const base = await loadStats(basePath);
const pr = await loadStats(prPath);
const routes = [...new Set([...base.keys(), ...pr.keys()])].sort();

const rows = routes.map((route) => {
  const baseBytes = base.get(route);
  const prBytes = pr.get(route);

  if (baseBytes === undefined && prBytes !== undefined) {
    return `| 🆕 \`${route}\` | — | ${formatKiB(prBytes)} | — |`;
  }
  if (baseBytes !== undefined && prBytes === undefined) {
    return `| 🗑️ \`${route}\` | ${formatKiB(baseBytes)} | — | — |`;
  }
  if (baseBytes === undefined || prBytes === undefined) {
    return '';
  }

  const delta = prBytes - baseBytes;
  let emoji = '⚪';
  if (delta >= ALERT_BYTES) {
    emoji = '🔴';
  } else if (delta >= NOISE_BYTES) {
    emoji = '🟡';
  } else if (delta <= -NOISE_BYTES) {
    emoji = '🟢';
  }
  const diff = Math.abs(delta) < NOISE_BYTES ? '—' : formatDiff(delta, baseBytes);
  return `| ${emoji} \`${route}\` | ${formatKiB(baseBytes)} | ${formatKiB(prBytes)} | ${diff} |`;
});

// 合計行: ルート間で共有されるチャンクを二重計上しないよう、ユニークなチャンク実ファイルの合計で出す
const baseTotal = await totalUniqueChunkBytes(basePath);
const prTotal = await totalUniqueChunkBytes(prPath);
if (baseTotal > 0 && prTotal > 0) {
  const delta = prTotal - baseTotal;
  let emoji = '⚪';
  if (delta >= ALERT_BYTES) {
    emoji = '🔴';
  } else if (delta >= NOISE_BYTES) {
    emoji = '🟡';
  } else if (delta <= -NOISE_BYTES) {
    emoji = '🟢';
  }
  const diff = Math.abs(delta) < NOISE_BYTES ? '—' : formatDiff(delta, baseTotal);
  rows.push(
    `| ${emoji} **Total (unique chunks)** | **${formatKiB(baseTotal)}** | **${formatKiB(prTotal)}** | ${diff} |`,
  );
}

// GitHub が Markdown 中の Mermaid をレンダリングするのを利用し、PR 側のサイズを棒グラフで可視化する
const chartRoutes = routes.filter((route) => pr.has(route));
const chartLines = [
  '```mermaid',
  'xychart-beta',
  '    title "First Load JS (KiB)"',
  `    x-axis [${chartRoutes.map((route) => `"${route}"`).join(', ')}]`,
  '    y-axis "KiB"',
  `    bar [${chartRoutes.map((route) => ((pr.get(route) ?? 0) / 1024).toFixed(1)).join(', ')}]`,
  '```',
];

const lines = [
  COMMENT_MARKER,
  '### 📦 Bundle Size (First Load JS, uncompressed)',
  '',
  '| Route | Base | PR | Diff |',
  '| --- | ---: | ---: | ---: |',
  ...rows.filter(Boolean),
  '',
  ...chartLines,
  '',
  `> 🔴 ≥ +${formatKiB(ALERT_BYTES)} / 🟡 increased / 🟢 decreased / ⚪ within ±${formatKiB(NOISE_BYTES)}.`,
  "> Calculated from Turbopack's `route-bundle-stats.json` (uncompressed).",
];

console.log(lines.join('\n'));
