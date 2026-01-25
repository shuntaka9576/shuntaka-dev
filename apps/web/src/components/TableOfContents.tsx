'use client';

import { useEffect, useRef } from 'react';
import type tocbotModule from 'tocbot';

export function TableOfContents() {
  const tocbotRef = useRef<typeof tocbotModule | null>(null);

  useEffect(() => {
    const initTocbot = async () => {
      const content = document.querySelector('.prose');
      if (!content) return;

      const headings = content.querySelectorAll('h1, h2, h3');
      if (headings.length === 0) return;

      // Ensure all headings have IDs
      headings.forEach((heading, index) => {
        if (!heading.id) {
          heading.id = `heading-${index}`;
        }
      });

      // Dynamic import tocbot
      const tocbot = (await import('tocbot')).default;
      tocbotRef.current = tocbot;

      tocbot.init({
        tocSelector: '.toc',
        contentSelector: '.prose',
        headingSelector: 'h1, h2, h3',
        scrollSmooth: false,
        headingsOffset: 100,
        scrollSmoothOffset: 0,
      });
    };

    // Wait for layout to stabilize
    const timer = setTimeout(() => {
      void initTocbot();
    }, 300);

    return () => {
      clearTimeout(timer);
      tocbotRef.current?.destroy();
    };
  }, []);

  return <div className="toc" />;
}
