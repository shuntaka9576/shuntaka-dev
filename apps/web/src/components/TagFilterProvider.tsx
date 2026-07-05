'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ArticleSummary, TagFacet } from '@/lib/api';
import { getArticlesByType, getTagFacets } from '@/lib/api';
import { ARTICLES_PER_PAGE } from '@/lib/constants';
import {
  buildFilterQuery,
  buildTagTreeFromFacets,
  parseModeParam,
  parseTagsParam,
  type TagFilterMode,
  type TagNode,
} from '@/lib/tagFilter';

export const TAG_FILTER_PANEL_ID = 'tag-filter-panel';

interface TagFilterContextValue {
  panelOpen: boolean;
  selected: string[];
  mode: TagFilterMode;
  /** 選択タグが1つ以上あるか */
  filtering: boolean;
  /** タグのルート名（"tech" or "misc"）。FilteredArticleList でのタグ変換に使用 */
  tagRoot: string;
  /** 絞り込み中の記事一覧。フィルタなし時は null（SSR の children を表示する） */
  fetchedArticles: ArticleSummary[] | null;
  /** API レスポンスの totalCount（ActiveTagBar のヒット件数表示用） */
  totalCount: number;
  /** 絞り込み中の現在ページ番号 */
  filterPage: number;
  /** 絞り込み結果の総ページ数 */
  filteredTotalPages: number;
  loading: boolean;
  error: string | null;
  /** タグパネルに表示するツリー（facets から構築） */
  tagTree: TagNode[];
  togglePanel: () => void;
  toggleTag: (path: string) => void;
  changeMode: (mode: TagFilterMode) => void;
  clear: () => void;
  setFilterPage: (page: number) => void;
  retry: () => void;
  /** 相対パスが選択中のタグにマッチするか（ArticleCard タグ強調用） */
  isTagMatched: (path: string) => boolean;
}

const TagFilterContext = createContext<TagFilterContextValue | null>(null);

export function useTagFilter(): TagFilterContextValue {
  const value = useContext(TagFilterContext);
  if (!value) throw new Error('useTagFilter must be used within TagFilterProvider');
  return value;
}

interface TagFilterProviderProps {
  userName: string;
  type: 'tech' | 'note';
  /** タグのルート階層。tech タブ → "tech"、note タブ → "misc" */
  tagRoot: string;
  /** SSR 時に取得した type 全体のファセット（パネル初期表示用） */
  initialFacets: TagFacet[];
  /** SSR 時の総ページ数（フィルタなし時の Pagination に渡す） */
  initialTotalPages: number;
  /** SSR 時の現在ページ番号 */
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
 * シャローナビゲーションで行う。SSR は常に絞り込みなしで描画し、直リンク時は
 * マウント後の effect で URL から状態を復元する。
 *
 * 絞り込み中はブラウザから一覧 API と tag-facets API を並列フェッチする。
 * AbortController で古いリクエストをキャンセルし、UI の巻き戻しを防ぐ。
 */
export function TagFilterProvider({
  userName,
  type,
  tagRoot,
  initialFacets,
  page,
  baseHref,
  children,
}: TagFilterProviderProps) {
  const [panelOpen, setPanelOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [mode, setMode] = useState<TagFilterMode>('and');
  const [filterPage, setFilterPageState] = useState(1);

  const [fetchedArticles, setFetchedArticles] = useState<ArticleSummary[] | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const [filteredTotalPages, setFilteredTotalPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [facets, setFacets] = useState<TagFacet[]>(initialFacets);
  const [retryCount, setRetryCount] = useState(0);

  // initialFacets を ref で保持し、effect の deps から除外する
  const initialFacetsRef = useRef(initialFacets);

  const filtering = selected.length > 0;

  // 直リンク・リロード・戻る/進むで URL から選択状態を復元する
  useEffect(() => {
    const readFromLocation = () => {
      const params = new URLSearchParams(window.location.search);
      setSelected(parseTagsParam(params.get('tags')));
      setMode(parseModeParam(params.get('mode')));
      const pageParam = params.get('page');
      setFilterPageState(pageParam ? Math.max(1, parseInt(pageParam, 10)) : 1);
    };
    readFromLocation();
    window.addEventListener('popstate', readFromLocation);
    return () => window.removeEventListener('popstate', readFromLocation);
  }, []);

  // フィルタ変更時に一覧 API と facets API を並列フェッチする
  useEffect(() => {
    if (!filtering) {
      // フィルタクリア時は SSR 初期ファセットに戻す
      setFetchedArticles(null);
      setFacets(initialFacetsRef.current);
      setError(null);
      return;
    }

    const controller = new AbortController();
    const { signal } = controller;

    setLoading(true);
    setError(null);

    // selected（相対パス）に root プレフィックスを付与してフルパスにする
    const fullPathTags = selected.map((tag) => `${tagRoot}/${tag}`);

    const listPromise = getArticlesByType(userName, type, {
      tags: fullPathTags,
      mode,
      page: filterPage,
      perPage: ARTICLES_PER_PAGE,
      noCache: true,
      signal,
    });

    // OR モードは「全タグ表示」のため initialFacets をそのまま使い、API を呼ばない
    const facetsPromise =
      mode === 'or'
        ? Promise.resolve({ facets: initialFacetsRef.current })
        : getTagFacets(userName, type, { tags: fullPathTags, noCache: true, signal });

    Promise.all([listPromise, facetsPromise])
      .then(([listResult, facetsResult]) => {
        setFetchedArticles(listResult.articles);
        setTotalCount(listResult.totalCount);
        setFilteredTotalPages(listResult.totalPages);
        setFacets(facetsResult.facets);
        setLoading(false);
      })
      .catch((err) => {
        if ((err as Error)?.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : 'エラーが発生しました');
        setLoading(false);
      });

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtering, selected, mode, filterPage, retryCount, userName, type, tagRoot]);

  const tagTree = useMemo(
    () => buildTagTreeFromFacets(facets, tagRoot),
    [facets, tagRoot],
  );

  // 絞り込み URL はタブの先頭ページ（baseHref）に載せる
  // 選択が空になったら SSR が表示していたページ URL に戻す
  const unfilteredHref = page > 1 ? `${baseHref.replace(/\/$/, '')}/page/${page}` : baseHref;

  const pushFilterUrl = useCallback(
    (
      nextSelected: string[],
      nextMode: TagFilterMode,
      nextFilterPage: number,
      replace = false,
    ) => {
      let url: string;
      if (nextSelected.length === 0) {
        url = unfilteredHref;
      } else {
        const query = buildFilterQuery(nextSelected, nextMode);
        const pageParam = nextFilterPage > 1 ? `&page=${nextFilterPage}` : '';
        url = `${baseHref}${query}${pageParam}`;
      }
      if (replace) {
        window.history.replaceState(null, '', url);
      } else {
        window.history.pushState(null, '', url);
      }
    },
    [baseHref, unfilteredHref],
  );

  const applySelection = useCallback(
    (nextSelected: string[], nextMode: TagFilterMode, replace = false) => {
      setSelected(nextSelected);
      setMode(nextMode);
      setFilterPageState(1); // フィルタ変更時は1ページ目に戻す
      pushFilterUrl(nextSelected, nextMode, 1, replace);
    },
    [pushFilterUrl],
  );

  const setFilterPage = useCallback(
    (p: number) => {
      setFilterPageState(p);
      pushFilterUrl(selected, mode, p);
    },
    [selected, mode, pushFilterUrl],
  );

  const retry = useCallback(() => setRetryCount((c) => c + 1), []);

  const value: TagFilterContextValue = {
    panelOpen,
    selected,
    mode,
    filtering,
    tagRoot,
    fetchedArticles,
    totalCount,
    filterPage,
    filteredTotalPages,
    loading,
    error,
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
    setFilterPage,
    retry,
    isTagMatched: (path) => selected.some((s) => path === s || path.startsWith(`${s}/`)),
  };

  return <TagFilterContext.Provider value={value}>{children}</TagFilterContext.Provider>;
}
