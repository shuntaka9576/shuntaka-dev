import { fetchLab } from '$lib/api';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ params }) => {
  return fetchLab(params.labSlug);
};
