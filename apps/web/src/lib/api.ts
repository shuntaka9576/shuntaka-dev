export interface Article {
  articleId: string;
  title: string;
  slug: string;
  content: string;
  contentHtml?: string;
  description: string;
  type: string | null;
  thumbnail: string | null;
  ogpUrl: string;
  publishedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ArticlesResponse {
  articles: Article[];
}

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080';

export async function getArticlesByType(
  userName: string,
  type: 'tech' | 'note'
): Promise<Article[]> {
  const res = await fetch(
    `${API_BASE_URL}/users/${userName}/articles?type=${type}`,
    { next: { revalidate: 30 } }
  );

  if (!res.ok) {
    throw new Error(`Failed to fetch articles: ${res.status}`);
  }

  const data: ArticlesResponse = await res.json();
  return data.articles;
}

export async function getArticleBySlug(
  userName: string,
  slug: string
): Promise<Article | null> {
  const res = await fetch(
    `${API_BASE_URL}/users/${userName}/articles/${slug}`,
    { next: { revalidate: 30 } }
  );

  if (res.status === 404) {
    return null;
  }

  if (!res.ok) {
    throw new Error(`Failed to fetch article: ${res.status}`);
  }

  return res.json();
}
