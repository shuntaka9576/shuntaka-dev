import { fetchLabs } from '#lib/api.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async () => {
  return fetchLabs();
};
