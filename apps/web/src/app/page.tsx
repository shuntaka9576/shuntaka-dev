import { ArticleCard } from '@/components/ArticleCard';
import { BaseLayout } from '@/components/BaseLayout';
import { PageReady } from '@/components/PageReady';
import { getArticlesByType } from '@/lib/api';

const USER_NAME = process.env.NEXT_PUBLIC_USER_NAME || 'shuntaka';

export default async function Home() {
  let articles: Awaited<ReturnType<typeof getArticlesByType>> = [];
  let error: string | null = null;

  try {
    articles = await getArticlesByType(USER_NAME, 'tech');
  } catch (e) {
    error = e instanceof Error ? e.message : 'Failed to fetch articles';
  }

  return (
    <BaseLayout showTypeHeader currentTab="tech">
      <main className="w-full">
        <div className="max-w-[600px]">
          {error ? (
            <p className="text-red-500">{error}</p>
          ) : articles.length === 0 ? (
            <p>No articles found.</p>
          ) : (
            articles.map((article) => (
              <ArticleCard key={article.articleId} article={article} userName={USER_NAME} />
            ))
          )}
        </div>
        <PageReady />
      </main>
    </BaseLayout>
  );
}
