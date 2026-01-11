'use client';

import { useEffect, useRef } from 'react';

declare global {
  interface Window {
    twttr?: {
      widgets: {
        load: (element?: HTMLElement) => Promise<void>;
      };
    };
  }
}

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

  // Handle initial hash scroll on page load
  // biome-ignore lint/correctness/useExhaustiveDependencies: Re-run when html changes to scroll after content is rendered
  useEffect(() => {
    const hash = window.location.hash;
    if (!hash) return;

    const id = hash.slice(1);
    let attempts = 0;
    const maxAttempts = 10;
    let timerId: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const tryScroll = () => {
      if (cancelled) return;

      const element = document.getElementById(id);
      if (element) {
        element.scrollIntoView({ behavior: 'smooth' });
        return;
      }
      attempts++;
      if (attempts < maxAttempts) {
        timerId = setTimeout(tryScroll, 100);
      }
    };

    timerId = setTimeout(tryScroll, 50);

    return () => {
      cancelled = true;
      if (timerId) clearTimeout(timerId);
    };
  }, [html]);

  // Load X (Twitter) widgets.js and initialize embeds
  // biome-ignore lint/correctness/useExhaustiveDependencies: Re-run when html changes to detect new X embeds
  useEffect(() => {
    const container = contentRef.current;
    if (!container) return;

    // Check if there are any X embeds
    const xEmbeds = container.querySelectorAll('.twitter-tweet');
    if (xEmbeds.length === 0) return;

    // If widgets.js is already loaded, just reinitialize
    if (window.twttr?.widgets) {
      window.twttr.widgets.load(container);
      return;
    }

    // Check if script is already being loaded
    const existingScript = document.querySelector(
      'script[src="https://platform.twitter.com/widgets.js"]'
    );
    if (existingScript) {
      // Wait for it to load
      existingScript.addEventListener('load', () => {
        window.twttr?.widgets.load(container);
      });
      return;
    }

    // Load widgets.js dynamically
    const script = document.createElement('script');
    script.src = 'https://platform.twitter.com/widgets.js';
    script.async = true;
    script.onload = () => {
      window.twttr?.widgets.load(container);
    };
    document.body.appendChild(script);
  }, [html]);

  return (
    <div
      ref={contentRef}
      className="prose prose-lg max-w-none"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
