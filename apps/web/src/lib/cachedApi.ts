import { cacheLife } from 'next/cache';
import {
  getArticleBySlug,
  getArticles,
  getMoments,
  getTagFacets,
  type ArticlesQueryOptions,
  type MomentsQueryOptions,
  type TagFacetsOptions,
} from './api';

type CachedArticlesQueryOptions = Omit<ArticlesQueryOptions, 'noCache' | 'signal'>;
type CachedTagFacetsOptions = Omit<TagFacetsOptions, 'noCache' | 'signal'>;
type CachedMomentsQueryOptions = Omit<MomentsQueryOptions, 'noCache' | 'signal'>;

export async function getCachedArticles(userName: string, opts: CachedArticlesQueryOptions = {}) {
  'use cache';
  cacheLife('blog');
  return getArticles(userName, opts);
}

export async function getCachedTagFacets(userName: string, opts: CachedTagFacetsOptions = {}) {
  'use cache';
  cacheLife('blog');
  return getTagFacets(userName, opts);
}

export async function getCachedMoments(userName: string, opts: CachedMomentsQueryOptions = {}) {
  'use cache';
  cacheLife('blog');
  return getMoments(userName, opts);
}

export async function getCachedArticleBySlug(userName: string, slug: string) {
  'use cache';
  cacheLife('blog');
  return getArticleBySlug(userName, slug);
}
