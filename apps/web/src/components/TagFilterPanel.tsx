'use client';

import { useState } from 'react';
import type { TagFilterMode, TagNode } from '@/lib/tagFilter';

interface TagFilterPanelProps {
  id: string;
  nodes: TagNode[];
  selected: string[];
  mode: TagFilterMode;
  onToggleTag: (path: string) => void;
  onModeChange: (mode: TagFilterMode) => void;
}

interface TagPillProps {
  node: TagNode;
  selected: boolean;
  onToggle: (path: string) => void;
}

function TagPill({ node, selected, onToggle }: TagPillProps) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={() => onToggle(node.path)}
      className={`inline-flex items-center gap-1 rounded-[var(--radius-sm)] border px-2 py-0.5 text-[length:var(--fs-caption)] ${
        selected
          ? 'border-[var(--color-text)] text-[var(--color-text)]'
          : 'border-[var(--color-border)] text-[var(--color-text-muted)]'
      }`}
    >
      #{node.label}
      <span className="text-[var(--color-text-muted)]">{node.count}</span>
    </button>
  );
}

/** 展開グループ内のセグメント。枠はグループが持つため選択状態は文字で示す */
function TagGroupSegment({
  node,
  child = false,
  selected,
  onToggle,
}: TagPillProps & { child?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={() => onToggle(node.path)}
      className={`inline-flex items-center gap-1 px-2 py-0.5 text-[length:var(--fs-caption)] ${
        selected ? 'font-medium text-[var(--color-text)]' : 'text-[var(--color-text-muted)]'
      }`}
    >
      {child ? `/${node.label}` : `#${node.label}`}
      <span className="font-normal text-[var(--color-text-muted)]">{node.count}</span>
    </button>
  );
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

/** 選択中の子タグ（"aws/lambda" 等）の親パスを求め、パネルを開いた時点で自動展開する */
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

export function TagFilterPanel({
  id,
  nodes,
  selected,
  mode,
  onToggleTag,
  onModeChange,
}: TagFilterPanelProps) {
  // 子タグの展開状態はローカル state のみ（URL に載せない）
  const [expanded, setExpanded] = useState<string[]>(() => parentPathsOf(selected));

  const toggleExpand = (path: string) => {
    setExpanded((prev) => (prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path]));
  };

  return (
    <div id={id} className="mb-4 border-b border-[var(--color-border-subtle)] pb-4">
      <div className="flex flex-wrap items-center gap-2">
        {nodes.map((node) => {
          const isExpanded = node.children.length > 0 && expanded.includes(node.path);
          if (!isExpanded) {
            return (
              <span key={node.path} className="inline-flex items-center">
                <TagPill
                  node={node}
                  selected={selected.includes(node.path)}
                  onToggle={onToggleTag}
                />
                {node.children.length > 0 && (
                  <button
                    type="button"
                    aria-expanded={false}
                    aria-label={`${node.label} の子タグを表示`}
                    onClick={() => toggleExpand(node.path)}
                    className="inline-flex items-center px-1 py-1 text-[var(--color-text-muted)]"
                  >
                    <ChevronIcon expanded={false} />
                  </button>
                )}
              </span>
            );
          }
          // 展開中は親 + 子を1つの枠に収め、他のタグと混ざらないようにする
          return (
            <span
              key={node.path}
              className="inline-flex flex-wrap items-center divide-x divide-[var(--color-border-subtle)] overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-border)]"
            >
              <TagGroupSegment
                node={node}
                selected={selected.includes(node.path)}
                onToggle={onToggleTag}
              />
              {node.children.map((childNode) => (
                <TagGroupSegment
                  key={childNode.path}
                  node={childNode}
                  child
                  selected={selected.includes(childNode.path)}
                  onToggle={onToggleTag}
                />
              ))}
              <button
                type="button"
                aria-expanded={true}
                aria-label={`${node.label} の子タグを閉じる`}
                onClick={() => toggleExpand(node.path)}
                className="inline-flex items-center self-stretch px-1 text-[var(--color-text-muted)]"
              >
                <ChevronIcon expanded={true} />
              </button>
            </span>
          );
        })}
      </div>
      {selected.length >= 2 && (
        <div className="mt-3 flex items-center gap-2 text-[length:var(--fs-caption)]">
          <div
            role="group"
            aria-label="絞り込み条件"
            className="inline-flex divide-x divide-[var(--color-border)] overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-border)]"
          >
            <button
              type="button"
              aria-pressed={mode === 'and'}
              onClick={() => onModeChange('and')}
              className={`px-2 py-0.5 ${
                mode === 'and'
                  ? 'font-medium text-[var(--color-text)]'
                  : 'text-[var(--color-text-muted)]'
              }`}
            >
              AND
            </button>
            <button
              type="button"
              aria-pressed={mode === 'or'}
              onClick={() => onModeChange('or')}
              className={`px-2 py-0.5 ${
                mode === 'or'
                  ? 'font-medium text-[var(--color-text)]'
                  : 'text-[var(--color-text-muted)]'
              }`}
            >
              OR
            </button>
          </div>
          <span className="text-[var(--color-text-muted)]">
            {mode === 'and' ? 'すべてのタグを含む記事' : 'いずれかのタグを含む記事'}
          </span>
        </div>
      )}
    </div>
  );
}
