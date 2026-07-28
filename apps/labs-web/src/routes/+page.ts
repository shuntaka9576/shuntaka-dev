import { fetchLabs } from '$lib/api';
import type { PageLoad } from './$types';

export const load: PageLoad = async () => {
  return fetchLabs();
};
