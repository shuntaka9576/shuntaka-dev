'use client';

import { useMemo } from 'react';
import type { TagNode } from '@/lib/tagFilter';

interface TagCloudProps {
  /** buildTagTreeFromFacets で組み立てたルートノード配列 */
  nodes: TagNode[];
  selected: string[];
  onToggleTag: (path: string) => void;
}

/** ルート配下（自身含む）を DFS で平坦化する */
function walkTree(node: TagNode): TagNode[] {
  return [node, ...node.children.flatMap(walkTree)];
}

/**
 * ルート (tech / misc など) 単位でセクション化し、その配下の全ノードを
 * 件数降順に並べた等サイズの pill として敷き詰める。
 *
 * デザイン方針:
 *   - サイズは等倍。並び順で件数の大きさが分かるので、font-size 変化は入れない
 *   - セクション見出しは uppercase + tracking で "editorial" な質感
 *   - pill は `radius-full`、`#` プレフィックスは付けずラベルだけ (DESIGN.md の
 *     "タグ = radius-sm" は article metadata 向けなので、interactive filter は例外扱い)
 *   - 件数は tabular-nums の muted 表記で邪魔しない
 *   - 選択状態は border 色を text 色に強調 + font-medium
 */
export function TagCloud({ nodes, selected, onToggleTag }: TagCloudProps) {
  // ルートごとに DFS + 件数降順ソートした結果は入力 (nodes) が変わったときだけ再計算する。
  // タグ選択のたびに TagFilterProvider の re-render で TagCloud も再描画されるため。
  const flatByRoot = useMemo(
    () =>
      nodes.map((root) => ({
        root,
        flat: walkTree(root).sort((a, b) => b.count - a.count || a.path.localeCompare(b.path)),
      })),
    [nodes],
  );

  return (
    <div className="flex flex-col gap-4">
      {flatByRoot.map(({ root, flat }) => {
        return (
          <section key={root.path}>
            <div className="mb-2 flex items-baseline gap-2 text-[length:var(--fs-caption)] tracking-wide text-[var(--color-text-muted)] uppercase">
              <span>{root.label}</span>
              <span className="tabular-nums opacity-60">{root.count}</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {flat.map((node) => {
                const isSelected = selected.includes(node.path);
                const label =
                  node.path === root.path ? node.label : node.path.slice(root.path.length + 1);
                return (
                  <button
                    key={node.path}
                    type="button"
                    onClick={() => onToggleTag(node.path)}
                    aria-pressed={isSelected}
                    className={`inline-flex items-baseline gap-1.5 rounded-[var(--radius-full)] border px-3 py-1 text-[length:var(--fs-caption)] ${
                      isSelected
                        ? 'border-[var(--color-text)] font-medium text-[var(--color-text)]'
                        : 'border-[var(--color-border)] text-[var(--color-text)]'
                    }`}
                  >
                    <span>{label}</span>
                    <span className="tabular-nums text-[var(--color-text-muted)]">
                      {node.count}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
