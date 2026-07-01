import crypto from 'node:crypto';

export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rng: () => number, arr: readonly T[]): T {
  const item = arr[Math.floor(rng() * arr.length)];
  if (item === undefined) throw new Error('pick: empty array');
  return item;
}

export function randInt(rng: () => number, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

export function uuid(): string {
  return crypto.randomUUID();
}

const PARAGRAPHS: readonly string[] = [
  '## はじめに\n\nこの記事では、実装の詳細と設計判断についてまとめる。読み手は Backend / SRE 寄りのエンジニアを想定している。',
  '技術選定にあたっては、いくつかのトレードオフを検討した。特にパフォーマンスと保守性の両立が難しく、最終的には計測結果を基に判断した。',
  'The initial approach was to use a simple in-memory cache. However, that turned out to have serious scaling issues under concurrent load, so we switched to a shared cache with TTL-based invalidation.',
  '## アーキテクチャ\n\nシステム全体は 3 層構造で、Presentation / Application / Infrastructure の各層が明確に分離されている。層間の依存関係は Dependency Rule に従い、内向きにのみ許可される。',
  '実装コード:\n\n```typescript\nexport function processRequest(input: Input): Result {\n  const validated = validate(input);\n  const domain = toDomain(validated);\n  return handle(domain);\n}\n```',
  'デプロイフローは GitHub Actions 上で `workflow_dispatch` を起点とし、Terraform + CDK の 2 段階で構成される。前段で state の drift を検出し、後段でアプリケーションを rolling deploy する。',
  '## パフォーマンス測定\n\nベンチマークは k6 で 60 秒 × 3 回、100 concurrent virtual users で計測した。中央値を採用し、外れ値は除外していない。',
  'The benchmark shows a 3x improvement in p95 latency after switching from OFFSET pagination to keyset pagination. The improvement is more pronounced at deeper pages.',
  '注意点として、この実装は eventually consistent であり、書き込み直後に読んでも古い値が返る可能性がある。強整合性が必要な read path では別の経路を使う。',
  '## 課題と展望\n\n現状の実装ではまだいくつかの改善余地がある。特に cold path の最適化と、observability の充実が今後の優先課題。',
  'RocksDB の block cache 圧迫を減らすため、垂直分割を検討している。ただし影響範囲が大きいので、まずはメトリクスを揃えてから判断したい。',
  'エラーハンドリングは Result<T, E> 型で明示的に扱う方針。panic は避け、boundary で必ず変換する。ライブラリ境界での型の一貫性を優先している。',
  "```sql\nSELECT article_id, title, published_at\nFROM articles\nWHERE status = 'published' AND `type` = ?\nORDER BY published_at DESC\nLIMIT 10;\n```",
  '結論として、この方針で本番投入して 1 週間安定運用を確認した。今後は監視の充実に注力し、SLO の閾値も再調整する。',
  '## 参考\n\n- 公式ドキュメント\n- コミュニティ Wiki\n- 実装リポジトリの README\n- 関連する RFC',
  '内部で使っているキャッシュ層の hit rate は 92% 前後。cold start 直後に一時的に落ち込むが、10 秒程度で定常状態に戻る。',
  'The migration itself was done in three phases: read-only shadow traffic, dual-write with reconcile, and full cutover. Each phase ran for at least a week before promoting.',
  '設計判断の記録として、なぜこの方式を採用したかを ADR に残している。将来同じ選択を迫られた時に、当時の文脈を含めて追えるようにする。',
];

const TITLE_PREFIXES: readonly string[] = [
  'TiDB',
  'PostgreSQL',
  'MySQL',
  'Rust',
  'TypeScript',
  'Next.js',
  'React',
  'Tailwind',
  'AWS',
  'Lambda',
  'DSQL',
  'Fargate',
  'ECS',
  'CDK',
  'Terraform',
  'GitHub Actions',
  'Tailscale',
  'DynamoDB',
  'OpenTelemetry',
  'Kubernetes',
];

const TITLE_TOPICS: readonly string[] = [
  '入門',
  '本番運用の記録',
  'パフォーマンス改善',
  'アーキテクチャ検討',
  '最適化の記録',
  'ハマりポイント',
  'コスト削減',
  'デプロイパイプライン',
  'メトリクス設計',
  'CDK 移行',
  'observability 導入',
  'incident post-mortem',
];

export function makeTitle(rng: () => number): string {
  return `${pick(rng, TITLE_PREFIXES)} の ${pick(rng, TITLE_TOPICS)}`;
}

export function makeDescription(rng: () => number): string {
  return pick(rng, PARAGRAPHS).replace(/\n/g, ' ').slice(0, 150);
}

const encoder = new TextEncoder();
const PARAGRAPH_BYTE_LENS: readonly number[] = PARAGRAPHS.map((p) => encoder.encode(p).length);

export function makeContent(rng: () => number, targetBytes: number): string {
  const n = PARAGRAPHS.length;
  const parts: string[] = [];
  let size = 0;
  while (size < targetBytes) {
    const i = Math.floor(rng() * n);
    parts.push(PARAGRAPHS[i] as string);
    size += (PARAGRAPH_BYTE_LENS[i] as number) + 2;
  }
  return parts.join('\n\n');
}

export function makeSlug(rng: () => number, index: number): string {
  const suffix = Math.floor(rng() * 1e9).toString(36);
  return `article-${index}-${suffix}`;
}

export function randomPastDate(rng: () => number, yearsBack: number): Date {
  const span = yearsBack * 365 * 24 * 60 * 60 * 1000;
  return new Date(Date.now() - Math.floor(rng() * span));
}

export function formatDateTime(d: Date): string {
  return `${d.toISOString().slice(0, 19).replace('T', ' ')}.000000`;
}

export interface EscapedPool {
  contents: string[];
  titles: string[];
  descriptions: string[];
}

export function buildEscapedPool(
  rng: () => number,
  contentSize: number,
  count: number,
  escape: (s: string) => string,
): EscapedPool {
  const contents: string[] = Array.from({ length: count });
  const titles: string[] = Array.from({ length: count });
  const descriptions: string[] = Array.from({ length: count });
  for (let i = 0; i < count; i++) {
    contents[i] = escape(makeContent(rng, contentSize));
    titles[i] = escape(makeTitle(rng));
    descriptions[i] = escape(makeDescription(rng));
  }
  return { contents, titles, descriptions };
}
