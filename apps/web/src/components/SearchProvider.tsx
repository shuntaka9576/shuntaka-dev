'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTagFilter } from '@/components/TagFilterProvider';
import type { SearchArticleResult } from '@/lib/api';
import { searchArticles } from '@/lib/api';
import { buildLocationSearch, parseSearchParam } from '@/lib/searchQuery';

/** 検索 fetch の debounce（ms）。過剰な API 呼び出しを避けつつ体感速度は保つ */
const DEBOUNCE_MS = 300;

/** 検索結果の1ページあたり件数。通常の記事一覧 (ARTICLES_PER_PAGE) と揃える */
const DEFAULT_LIMIT = 10;

interface SearchContextValue {
  /** input が現在保持している値。debounce 前 */
  query: string;
  /** debounce を通過して実際に API に送った値。空文字なら未検索 */
  submittedQuery: string;
  /** submittedQuery !== '' */
  searching: boolean;
  /** 直近の検索結果。まだ 1 度も取得していないなら null */
  results: SearchArticleResult[] | null;
  loading: boolean;
  error: string | null;
  /** 全画面モーダルの表示状態 */
  modalOpen: boolean;
  /** 検索結果の現在ページ番号（1-based） */
  searchPage: number;
  /** 検索結果の総ページ数 */
  searchTotalPages: number;
  setQuery: (next: string) => void;
  /** debounce をキャンセルして即時に submittedQuery を確定する（Enter キー用） */
  submitNow: () => void;
  clearQuery: () => void;
  retry: () => void;
  openModal: () => void;
  closeModal: () => void;
  setSearchPage: (page: number) => void;
}

const SearchContext = createContext<SearchContextValue | null>(null);

export function useSearch(): SearchContextValue {
  const value = useContext(SearchContext);
  if (!value) throw new Error('useSearch must be used within SearchProvider');
  return value;
}

interface SearchProviderProps {
  userName: string;
  children: React.ReactNode;
}

/**
 * 検索クエリと結果を保持する Provider。TagFilterProvider の内側に置き、
 * 選択タグ + mode を検索 API 呼び出しに合成する。
 *
 * URL 同期は TagFilterProvider と同じく history.pushState / popstate で行うが、
 * `q` パラメータだけ差し替え、既存の `tags` / `mode` / `page` は残す。
 */
export function SearchProvider({ userName, children }: SearchProviderProps) {
  const { selected, mode } = useTagFilter();

  const [query, setQueryState] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [results, setResults] = useState<SearchArticleResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [searchPage, setSearchPageState] = useState(1);
  const [searchTotalPages, setSearchTotalPages] = useState(1);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // 直リンク・戻る/進むで URL から q を復元する
  useEffect(() => {
    const applyFromLocation = () => {
      const params = new URLSearchParams(window.location.search);
      const q = parseSearchParam(params.get('q'));
      setQueryState(q);
      setSubmittedQuery(q);
    };
    applyFromLocation();
    window.addEventListener('popstate', applyFromLocation);
    return () => window.removeEventListener('popstate', applyFromLocation);
  }, []);

  // submittedQuery / 選択タグ / mode / searchPage / retry が変わったら fetch する
  useEffect(() => {
    if (!submittedQuery) {
      // 未検索状態にリセット
      setResults(null);
      setError(null);
      setLoading(false);
      setSearchTotalPages(1);
      abortRef.current?.abort();
      abortRef.current = null;
      return;
    }

    // 直前の request はキャンセルする（同時に走らないよう単一 AbortController に統合）
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);

    const offset = (searchPage - 1) * DEFAULT_LIMIT;

    searchArticles(userName, submittedQuery, {
      tags: selected,
      mode,
      limit: DEFAULT_LIMIT,
      offset,
      signal: controller.signal,
    })
      .then((res) => {
        setResults(res.articles);
        const pages = res.totalCount === 0 ? 1 : Math.ceil(res.totalCount / DEFAULT_LIMIT);
        setSearchTotalPages(pages);
        setLoading(false);
      })
      .catch((err) => {
        if ((err as Error)?.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : '検索に失敗しました');
        setLoading(false);
      });

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submittedQuery, selected, mode, searchPage, retryCount, userName]);

  /** URL の q パラメータを更新（tags/mode/page は維持）。同値なら何もしない */
  const pushSearchUrl = useCallback((nextQuery: string, replace = false) => {
    const current = window.location.search;
    const currentQ = new URLSearchParams(current).get('q') ?? '';
    if (currentQ.trim() === nextQuery.trim()) return;

    const nextSearch = buildLocationSearch(current, { q: nextQuery });
    const nextUrl = `${window.location.pathname}${nextSearch}${window.location.hash}`;
    if (replace) window.history.replaceState(null, '', nextUrl);
    else window.history.pushState(null, '', nextUrl);
  }, []);

  const setQuery = useCallback(
    (next: string) => {
      setQueryState(next);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        pushSearchUrl(next);
        setSubmittedQuery(next.trim());
        setSearchPageState(1);
      }, DEBOUNCE_MS);
    },
    [pushSearchUrl],
  );

  const submitNow = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    // 最新の入力値を確定させる（同期的に読める query state を使う）
    setQueryState((current) => {
      const trimmed = current.trim();
      pushSearchUrl(trimmed);
      setSubmittedQuery(trimmed);
      setSearchPageState(1);
      return current;
    });
  }, [pushSearchUrl]);

  const clearQuery = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    setQueryState('');
    pushSearchUrl('');
    setSubmittedQuery('');
  }, [pushSearchUrl]);

  const retry = useCallback(() => setRetryCount((c) => c + 1), []);
  const openModal = useCallback(() => setModalOpen(true), []);
  const closeModal = useCallback(() => setModalOpen(false), []);
  const setSearchPage = useCallback((p: number) => setSearchPageState(p), []);

  const value = useMemo<SearchContextValue>(
    () => ({
      query,
      submittedQuery,
      searching: submittedQuery.length > 0,
      results,
      loading,
      error,
      modalOpen,
      searchPage,
      searchTotalPages,
      setQuery,
      submitNow,
      clearQuery,
      retry,
      openModal,
      closeModal,
      setSearchPage,
    }),
    [
      query,
      submittedQuery,
      results,
      loading,
      error,
      modalOpen,
      searchPage,
      searchTotalPages,
      setQuery,
      submitNow,
      clearQuery,
      retry,
      openModal,
      closeModal,
      setSearchPage,
    ],
  );

  return <SearchContext.Provider value={value}>{children}</SearchContext.Provider>;
}
