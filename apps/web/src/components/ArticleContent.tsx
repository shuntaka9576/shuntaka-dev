'use client';

import { useEffect, useRef } from 'react';

interface ArticleContentProps {
  html: string;
}

const COPY_ICON = `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg>`;

export function ArticleContent({ html }: ArticleContentProps) {
  const contentRef = useRef<HTMLDivElement>(null);

  // Add copy buttons to all pre elements
  useEffect(() => {
    const container = contentRef.current;
    if (!container) return;

    const preElements = container.querySelectorAll('pre');
    preElements.forEach((pre) => {
      // Skip if already has a copy button
      if (pre.querySelector('.copy-btn')) {
        return;
      }

      // Make pre position relative for absolute positioning of button
      pre.style.position = 'relative';

      // Get code content
      const codeElement = pre.querySelector('code');
      const code = codeElement?.textContent || pre.textContent || '';

      // Create copy button
      const button = document.createElement('button');
      button.className = 'copy-btn';
      button.setAttribute('data-code', code);
      button.setAttribute('aria-label', 'Copy code');
      button.innerHTML = `<span class="copy-icon">${COPY_ICON}</span>`;

      pre.appendChild(button);
    });
  }, []);

  // Handle copy click
  useEffect(() => {
    const container = contentRef.current;
    if (!container) return;

    const handleCopyClick = async (e: MouseEvent) => {
      const button = (e.target as Element).closest(
        '.github-embed-copy, .code-block-copy, .copy-btn'
      );
      if (!button) return;

      const code = button.getAttribute('data-code');
      if (!code) return;

      try {
        await navigator.clipboard.writeText(code);

        // Create floating "Copied!" text
        const floatingText = document.createElement('span');
        floatingText.className = 'copied-float';
        floatingText.textContent = 'Copied!';
        button.appendChild(floatingText);

        // Remove after animation
        setTimeout(() => {
          floatingText.remove();
        }, 800);
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
