// admin-api に将来実装する labs read API と同じ契約。
// プレビュー中は preview/server.ts（モック）が同じレスポンス形を返す。
export type LabSummary = {
  slug: string;
  title: string;
  summary: string | null;
  published: boolean;
  chapterCount: number;
  updatedAt: string;
};

export type ChapterMeta = {
  slug: string;
  title: string;
  position: number;
};

export type LabDetail = {
  lab: LabSummary;
  chapters: ChapterMeta[];
};

export type ChapterDetail = {
  lab: LabSummary;
  chapters: ChapterMeta[];
  chapter: ChapterMeta & { contentHtml: string };
};

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { 'X-Requested-With': 'fetch' } });
  if (!res.ok) {
    throw new Error(`GET ${path} failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

export const fetchLabs = () => get<{ labs: LabSummary[] }>('/api/labs');

export const fetchLab = (labSlug: string) => get<LabDetail>(`/api/labs/${labSlug}`);

export const fetchChapter = (labSlug: string, chapterSlug: string) =>
  get<ChapterDetail>(`/api/labs/${labSlug}/chapters/${chapterSlug}`);
