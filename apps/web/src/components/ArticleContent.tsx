'use client';

import { useEffect, useRef } from 'react';

interface ArticleContentProps {
  html: string;
}

export function ArticleContent({ html }: ArticleContentProps) {
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = contentRef.current;
    if (!container) return;

    const handleCopyClick = async (e: MouseEvent) => {
      const button = (e.target as Element).closest('.github-embed-copy');
      if (!button) return;

      const code = button.getAttribute('data-code');
      if (!code) return;

      try {
        await navigator.clipboard.writeText(code);
        button.classList.add('copied');
        setTimeout(() => {
          button.classList.remove('copied');
        }, 2000);
      } catch (err) {
        console.error('Failed to copy:', err);
      }
    };

    container.addEventListener('click', handleCopyClick);
    return () => {
      container.removeEventListener('click', handleCopyClick);
    };
  }, []);

  return (
    <div
      ref={contentRef}
      className="prose prose-lg max-w-none"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
