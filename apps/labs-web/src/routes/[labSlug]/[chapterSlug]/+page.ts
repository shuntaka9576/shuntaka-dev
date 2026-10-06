import { fetchChapter } from '#lib/api.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ params }) => {
  return fetchChapter(params.labSlug, params.chapterSlug);
};
