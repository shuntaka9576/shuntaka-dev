export type TagFilterMode = 'or' | 'and';

export interface TagNode {
  /** root プレフィックスを除いた相対パス（例: "aws", "aws/lambda"） */
  path: string;
  /** 表示用の末尾セグメント（例: "lambda"） */
  label: string;
  /** 祖先マッチでヒットする記事数 */
  count: number;
  children: TagNode[];
}

/**
 * API のフルパスタグ（例: "tech/aws/lambda"）を現在タブの root（"tech" | "misc"）で
 * 相対パスに変換する。root 単独タグは絞り込み情報を持たないため除外し、
 * root が一致しないタグ（tech 記事に misc タグが付くケース）も UI に出さないため除外する。
 */
export function toRelativeTags(tags: string[], root: string): string[] {
  const prefix = `${root}/`;
  return tags.filter((tag) => tag.startsWith(prefix)).map((tag) => tag.slice(prefix.length));
}

/** 祖先マッチ。選択タグ "aws" は記事タグ "aws/lambda" にもヒットする */
export function matchesTag(selected: string, tags: string[]): boolean {
  return tags.some((tag) => tag === selected || tag.startsWith(`${selected}/`));
}

export function matchesSelection(tags: string[], selected: string[], mode: TagFilterMode): boolean {
  if (selected.length === 0) return true;
  return mode === 'and'
    ? selected.every((s) => matchesTag(s, tags))
    : selected.some((s) => matchesTag(s, tags));
}

/**
 * 記事ごとの相対タグ配列からタグツリーを構築する。
 * 件数は祖先タグへ合算し、同一記事内の重複（"aws/lambda" と "aws/cdk" を持つ記事の
 * "aws"）は1件として数える。並び順は件数降順、同数はパス昇順。
 */
export function buildTagTree(articlesTags: string[][]): TagNode[] {
  const counts = new Map<string, number>();
  for (const tags of articlesTags) {
    const prefixes = new Set<string>();
    for (const tag of tags) {
      const segments = tag.split('/');
      for (let i = 1; i <= segments.length; i += 1) {
        prefixes.add(segments.slice(0, i).join('/'));
      }
    }
    for (const prefix of prefixes) {
      counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    }
  }

  const nodes = new Map<string, TagNode>();
  const roots: TagNode[] = [];
  const sortedPaths = [...counts.keys()].sort();
  for (const path of sortedPaths) {
    const segments = path.split('/');
    const node: TagNode = {
      path,
      label: segments[segments.length - 1],
      count: counts.get(path) ?? 0,
      children: [],
    };
    nodes.set(path, node);
    if (segments.length === 1) {
      roots.push(node);
    } else {
      nodes.get(segments.slice(0, -1).join('/'))?.children.push(node);
    }
  }

  const byCountDesc = (a: TagNode, b: TagNode) => b.count - a.count || a.path.localeCompare(b.path);
  const sortTree = (list: TagNode[]) => {
    list.sort(byCountDesc);
    for (const node of list) sortTree(node.children);
  };
  sortTree(roots);
  return roots;
}

/** `?tags=` の値（カンマ区切り、URLSearchParams デコード済み）を選択タグ配列にする */
export function parseTagsParam(raw: string | null): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of raw.split(',')) {
    const tag = item.trim();
    // 空セグメントを含む不正なパス（"/aws"、"aws//lambda" 等）は無視する
    if (tag === '' || tag.split('/').some((seg) => seg === '')) continue;
    if (seen.has(tag)) continue;
    seen.add(tag);
    result.push(tag);
  }
  return result;
}

export function parseModeParam(raw: string | null): TagFilterMode {
  return raw === 'or' ? 'or' : 'and';
}

/**
 * 選択状態をクエリ文字列にする（例: "?tags=rust,aws%2Flambda&mode=or"）。
 * カンマは区切り文字として生のまま残し、タグ内の "/" はエンコードする。
 * mode はデフォルト（and）または選択タグが2つ未満のとき省略する。
 */
export function buildFilterQuery(selected: string[], mode: TagFilterMode): string {
  if (selected.length === 0) return '';
  const tags = selected.map(encodeURIComponent).join(',');
  const modeParam = mode === 'or' && selected.length >= 2 ? '&mode=or' : '';
  return `?tags=${tags}${modeParam}`;
}
