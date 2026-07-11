export type TagFilterMode = 'or' | 'and';

export interface TagNode {
  /** フルパス表記のタグ（例: "tech", "tech/aws/lambda"） */
  path: string;
  /** 表示用の末尾セグメント（例: "lambda"） */
  label: string;
  /** 祖先マッチでヒットする記事数 */
  count: number;
  children: TagNode[];
}

/** 祖先マッチ。選択タグ "tech/aws" は記事タグ "tech/aws/lambda" にもヒットする */
export function matchesTag(selected: string, tags: string[]): boolean {
  return tags.some((tag) => tag === selected || tag.startsWith(`${selected}/`));
}

/**
 * API の tag-facets レスポンス（path/count の配列、フルパス）からタグツリーを構築する。
 * ツリーの第1階層はルートタグ（例: "tech", "misc"）で、旧 type タブ相当の絞り込みになる。
 * count は API が祖先ロールアップ済みの値を返すためそのまま使用する。
 * 並び順は count 降順、同数はパス昇順。
 */
export function buildTagTreeFromFacets(facets: { path: string; count: number }[]): TagNode[] {
  const nodes = new Map<string, TagNode>();
  const roots: TagNode[] = [];

  // パス昇順でソートしてから処理することで、親が子より先に登録される
  const sorted = [...facets].sort((a, b) => a.path.localeCompare(b.path));

  for (const { path, count } of sorted) {
    const segments = path.split('/');
    const node: TagNode = {
      path,
      label: segments[segments.length - 1],
      count,
      children: [],
    };
    nodes.set(path, node);

    if (segments.length === 1) {
      roots.push(node);
    } else {
      const parentPath = segments.slice(0, -1).join('/');
      const parent = nodes.get(parentPath);
      if (parent) {
        parent.children.push(node);
      } else {
        // 親がファセットに含まれない場合はルートとして扱う
        roots.push(node);
      }
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
