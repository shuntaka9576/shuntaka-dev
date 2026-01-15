interface ArticleJsonLdProps {
  title: string;
  description: string;
  publishedAt: string | null;
  updatedAt: string | null;
  authorName: string;
  url: string;
  imageUrl?: string;
}

export function ArticleJsonLd({
  title,
  description,
  publishedAt,
  updatedAt,
  authorName,
  url,
  imageUrl,
}: ArticleJsonLdProps) {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: title,
    description,
    author: {
      '@type': 'Person',
      name: authorName,
    },
    datePublished: publishedAt,
    dateModified: updatedAt || publishedAt,
    url,
    ...(imageUrl && { image: imageUrl }),
  };

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
    />
  );
}
