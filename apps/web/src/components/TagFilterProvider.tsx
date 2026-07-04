'use client';

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ArticleSummary } from '@/lib/api';
import {
  buildFilterQuery,
  buildTagTree,
  matchesSelection,
  parseModeParam,
  parseTagsParam,
  type TagFilterMode,
  type TagNode,
  toRelativeTags,
} from '@/lib/tagFilter';

export const TAG_FILTER_PANEL_ID = 'tag-filter-panel';

export interface TagFilterEntry {
  article: ArticleSummary;
  relativeTags: string[];
}

interface TagFilterContextValue {
  panelOpen: boolean;
  selected: string[];
  mode: TagFilterMode;
  /** 選択タグが1つ以上あるか */
  filtering: boolean;
  /** 現在の選択にヒットする記事（選択なしなら全件） */
  matched: TagFilterEntry[];
  tagTree: TagNode[];
  togglePanel: () => void;
  toggleTag: (path: string) => void;
  changeMode: (mode: TagFilterMode) => void;
  clear: () => void;
  isTagMatched: (path: string) => boolean;
}

const TagFilterContext = createContext<TagFilterContextValue | null>(null);

export function useTagFilter(): TagFilterContextValue {
  const value = useContext(TagFilterContext);
  if (!value) throw new Error('useTagFilter must be used within TagFilterProvider');
  return value;
}

interface TagFilterProviderProps {
  articles: ArticleSummary[];
  /** タグのルート階層。tech タブ → "tech"、note タブ → "misc" */
  tagRoot: string;
  page: number;
  baseHref: string;
  children: React.ReactNode;
}

/**
 * タグ絞り込みの状態を保持する Context Provider。
 *
 * 一覧本体はサーバーレンダリングのまま children として通し、絞り込み UI だけを
 * クライアントアイランドとして配置する。一覧全体をクライアントコンポーネント化
 * するとプリレンダリングが loading.tsx 込みのストリーミング形に変わり、
 * ハイドレーションが不安定になるため、この構造を崩さないこと。
 *
 * URL 同期は useSearchParams ではなく history.pushState / popstate による
 * シャローナビゲーションで行う。useSearchParams は静的ルートで Suspense 境界を
 * 要求するため使わない。SSR は常に絞り込みなしで描画し、直リンク時はマウント後の
 * effect で URL から状態を復元する。
 */
export function TagFilterProvider({
  articles,
  tagRoot,
  page,
  baseHref,
  children,
}: TagFilterProviderProps) {
  const [panelOpen, setPanelOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [mode, setMode] = useState<TagFilterMode>('and');

  // 直リンク・リロード・戻る/進むで URL から選択状態を復元する
  useEffect(() => {
    const readFromLocation = () => {
      const params = new URLSearchParams(window.location.search);
      setSelected(parseTagsParam(params.get('tags')));
      setMode(parseModeParam(params.get('mode')));
    };
    readFromLocation();
    window.addEventListener('popstate', readFromLocation);
    return () => window.removeEventListener('popstate', readFromLocation);
  }, []);

  const entries = useMemo(
    () =>
      articles.map((article) => ({
        article,
        relativeTags: toRelativeTags(article.tags ?? [], tagRoot),
      })),
    [articles, tagRoot],
  );

  const filtering = selected.length > 0;
  const matched = useMemo(
    () =>
      filtering ? entries.filter((e) => matchesSelection(e.relativeTags, selected, mode)) : entries,
    [entries, filtering, selected, mode],
  );

  // AND（デフォルト）ではヒット集合と組み合わせられるタグだけをパネルに出し、
  // 0件になる組み合わせを選べなくする（ファセット表示）。OR は選択で結果が
  // 広がるため全タグを出す。直リンクで0件になった場合は全タグにフォールバック
  const tagTree = useMemo(() => {
    const source = mode === 'and' && matched.length > 0 ? matched : entries;
    return buildTagTree(source.map((e) => e.relativeTags));
  }, [entries, matched, mode]);

  // 絞り込み URL はタブの先頭ページ（baseHref）に載せ、選択が空になったら
  // このコンポーネントが表示しているページの URL に戻す（/page/N との整合）
  const unfilteredHref = page > 1 ? `${baseHref.replace(/\/$/, '')}/page/${page}` : baseHref;
  const applySelection = (nextSelected: string[], nextMode: TagFilterMode, replace = false) => {
    setSelected(nextSelected);
    setMode(nextMode);
    const url =
      nextSelected.length === 0
        ? unfilteredHref
        : `${baseHref}${buildFilterQuery(nextSelected, nextMode)}`;
    if (replace) {
      window.history.replaceState(null, '', url);
    } else {
      window.history.pushState(null, '', url);
    }
  };

  const value: TagFilterContextValue = {
    panelOpen,
    selected,
    mode,
    filtering,
    matched,
    tagTree,
    togglePanel: () => setPanelOpen((prev) => !prev),
    toggleTag: (path) => {
      const next = selected.includes(path)
        ? selected.filter((t) => t !== path)
        : [...selected, path];
      applySelection(next, mode);
    },
    changeMode: (nextMode) => applySelection(selected, nextMode, true),
    clear: () => applySelection([], 'and'),
    isTagMatched: (path) => selected.some((s) => path === s || path.startsWith(`${s}/`)),
  };

  return <TagFilterContext.Provider value={value}>{children}</TagFilterContext.Provider>;
}
