'use client';

import { useEffect } from 'react';
import tocbot from 'tocbot';

export function TableOfContents() {
  useEffect(() => {
    const initTocbot = () => {
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
    const timer = setTimeout(initTocbot, 300);

    return () => {
      clearTimeout(timer);
      tocbot.destroy();
    };
  }, []);

  return <div className="toc" />;
}
