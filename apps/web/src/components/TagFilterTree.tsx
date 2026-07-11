'use client';

import { useState } from 'react';
import type { TagNode } from '@/lib/tagFilter';

interface TagFilterTreeProps {
  nodes: TagNode[];
  selected: string[];
  onToggleTag: (path: string) => void;
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`transition-transform duration-[var(--motion-fast)] ${expanded ? 'rotate-90' : ''}`}
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

/** フォルダアイコン（Lucide "folder" / "folder-open" 相当、stroke 1.5px・塗りなし） */
function FolderIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      {open ? (
        <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
      ) : (
        <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
      )}
    </svg>
  );
}

/** タグアイコン（Lucide "tag" 相当、stroke 1.5px・塗りなし） */
function TagIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      <path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z" />
      <circle cx="7.5" cy="7.5" r="0.5" fill="currentColor" />
    </svg>
  );
}

/** 選択中の子タグ（"aws/lambda" 等）の親パスを求め、初期表示で自動展開する */
function parentPathsOf(selected: string[]): string[] {
  const parents = new Set<string>();
  for (const path of selected) {
    const segments = path.split('/');
    for (let i = 1; i < segments.length; i += 1) {
      parents.add(segments.slice(0, i).join('/'));
    }
  }
  return [...parents];
}

function TreeRow({
  node,
  depth,
  selected,
  expanded,
  onToggleTag,
  onToggleExpand,
}: {
  node: TagNode;
  depth: number;
  selected: string[];
  expanded: string[];
  onToggleTag: (path: string) => void;
  onToggleExpand: (path: string) => void;
}) {
  const isSelected = selected.includes(node.path);
  const isExpanded = node.children.length > 0 && expanded.includes(node.path);

  return (
    <li>
      <div
        className="flex items-center gap-1"
        style={{ paddingLeft: `calc(var(--space-4) * ${depth})` }}
      >
        {node.children.length > 0 ? (
          <button
            type="button"
            aria-expanded={isExpanded}
            aria-label={
              isExpanded ? `${node.label} の子タグを閉じる` : `${node.label} の子タグを表示`
            }
            onClick={() => onToggleExpand(node.path)}
            className="inline-flex min-h-6 min-w-6 items-center justify-center text-[var(--color-text-muted)]"
          >
            <ChevronIcon expanded={isExpanded} />
          </button>
        ) : (
          <span className="inline-block min-w-6" aria-hidden="true" />
        )}
        <button
          type="button"
          aria-pressed={isSelected}
          onClick={() => onToggleTag(node.path)}
          className={`inline-flex min-h-7 items-center gap-1.5 ${
            isSelected ? 'font-medium text-[var(--color-text)]' : 'text-[var(--color-text-muted)]'
          }`}
        >
          {node.children.length > 0 ? <FolderIcon open={isExpanded} /> : <TagIcon />}
          {node.label}
          <span className="font-normal text-[var(--color-text-muted)]">{node.count}</span>
        </button>
      </div>
      {isExpanded && (
        <ul>
          {node.children.map((child) => (
            <TreeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              selected={selected}
              expanded={expanded}
              onToggleTag={onToggleTag}
              onToggleExpand={onToggleExpand}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

/** ファイルツリー風のタグ階層。チェブロンで展開、ラベルクリックで絞り込みをトグルする */
export function TagFilterTree({ nodes, selected, onToggleTag }: TagFilterTreeProps) {
  // 展開状態はローカル state のみ（URL に載せない）
  const [expanded, setExpanded] = useState<string[]>(() => parentPathsOf(selected));

  const toggleExpand = (path: string) => {
    setExpanded((prev) => (prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path]));
  };

  return (
    <ul className="text-[length:var(--fs-caption)]">
      {nodes.map((node) => (
        <TreeRow
          key={node.path}
          node={node}
          depth={0}
          selected={selected}
          expanded={expanded}
          onToggleTag={onToggleTag}
          onToggleExpand={toggleExpand}
        />
      ))}
    </ul>
  );
}
