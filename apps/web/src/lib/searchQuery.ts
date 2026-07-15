/** URL の `?q=` パラメータを検索文字列に正規化する。前後空白は除去、null/空は空文字。 */
export function parseSearchParam(raw: string | null): string {
  if (!raw) return '';
  return raw.trim();
}

/**
 * URL に q / tags / mode を書き戻すための組み立てヘルパー。
 * 現在の URL の他のパラメータ（page など）を維持したまま、対象キーだけを差し替える。
 */
export interface SyncedParams {
  q?: string;
  tags?: string[];
  mode?: 'and' | 'or';
  /** true にすると q/tags/mode 以外のパラメータを削除する（絞り込みリセット時など） */
  strip?: boolean;
}

export function buildLocationSearch(currentSearch: string, next: SyncedParams): string {
  const params = new URLSearchParams(currentSearch);

  if (next.strip) {
    for (const key of Array.from(params.keys())) {
      if (key !== 'q' && key !== 'tags' && key !== 'mode') params.delete(key);
    }
  }

  if (next.q !== undefined) {
    const trimmed = next.q.trim();
    if (trimmed) params.set('q', trimmed);
    else params.delete('q');
  }

  if (next.tags !== undefined) {
    if (next.tags.length > 0) {
      // URLSearchParams が toString で `/` → `%2F`、`,` → `%2C` に自動 encode する。
      // 二重 encode を避けるため、ここでは encodeURIComponent せず生のまま join する
      params.set('tags', next.tags.join(','));
    } else {
      params.delete('tags');
      // タグが無くなれば mode は意味を持たないので同時に削除する
      params.delete('mode');
    }
  }

  if (next.mode !== undefined) {
    // and (default) or 単一タグ選択のときは mode を書かない
    const tagCount =
      next.tags !== undefined ? next.tags.length : parseTagsCount(params.get('tags'));
    if (next.mode === 'or' && tagCount >= 2) params.set('mode', 'or');
    else params.delete('mode');
  }

  const query = params.toString();
  return query ? `?${query}` : '';
}

function parseTagsCount(raw: string | null): number {
  if (!raw) return 0;
  return raw.split(',').filter((s) => s.length > 0).length;
}

/** cosine distance (0..2) を類似度 (0..1) に写像する。0 が最遠、1 が最近似。 */
export function distanceToSimilarity(distance: number): number {
  if (!Number.isFinite(distance)) return 0;
  const clamped = Math.max(0, Math.min(2, distance));
  return 1 - clamped / 2;
}
