'use client';

import type { ComponentProps } from 'react';
import { useEffect, useMemo, useRef } from 'react';
import { Tweet } from 'react-tweet';
import { useNavigationProgress } from '@/components/NavigationProgressProvider';

function AvatarImg({ src, ...props }: ComponentProps<'img'>) {
  const hiResSrc = typeof src === 'string' ? src.replace('_normal.', '_bigger.') : src;
  // biome-ignore lint/a11y/useAltText: alt is passed via ...props
  return <img src={hiResSrc} {...props} />;
}

interface ArticleContentProps {
  html: string;
}

type ContentPart = { type: 'html'; content: string } | { type: 'tweet'; id: string };

const TWEET_PLACEHOLDER_REGEX = /<div data-tweet-id="(\d+)"><\/div>/g;

function parseHtmlWithTweets(html: string): ContentPart[] {
  const parts: ContentPart[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  TWEET_PLACEHOLDER_REGEX.lastIndex = 0;
  while ((match = TWEET_PLACEHOLDER_REGEX.exec(html)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: 'html', content: html.slice(lastIndex, match.index) });
    }
    parts.push({ type: 'tweet', id: match[1] });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < html.length) {
    parts.push({ type: 'html', content: html.slice(lastIndex) });
  }

  return parts;
}

const COPY_ICON = `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg>`;

export function ArticleContent({ html }: ArticleContentProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const { doneProgress } = useNavigationProgress();

  const parts = useMemo(() => parseHtmlWithTweets(html), [html]);

  // Complete navigation progress after content is painted
  useEffect(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        doneProgress();
      });
    });
  }, [doneProgress]);

  // Add copy buttons to all pre elements
  useEffect(() => {
    const container = contentRef.current;
    if (!container) return;

    const preElements = container.querySelectorAll('pre');
    preElements.forEach((pre) => {
      if (pre.querySelector('.copy-btn')) {
        return;
      }

      pre.style.position = 'relative';

      const codeElement = pre.querySelector('code');
      const code = codeElement?.textContent || pre.textContent || '';

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

    const handleCopyClick = (e: MouseEvent) => {
      const button = (e.target as Element).closest(
        '.github-embed-copy, .code-block-copy, .copy-btn',
      );
      if (!button) return;

      const code = button.getAttribute('data-code');
      if (!code) return;

      navigator.clipboard.writeText(code).then(
        () => {
          const floatingText = document.createElement('span');
          floatingText.className = 'copied-float';
          floatingText.textContent = 'Copied!';
          button.appendChild(floatingText);

          setTimeout(() => {
            floatingText.remove();
          }, 800);
        },
        (err) => {
          console.error('Failed to copy:', err);
        },
      );
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

  return (
    <div ref={contentRef} className="prose prose-lg max-w-none">
      {parts.map((part, i) =>
        part.type === 'html' ? (
          <div key={i} dangerouslySetInnerHTML={{ __html: part.content }} />
        ) : (
          <div key={i} className="tweet-container">
            <Tweet id={part.id} components={{ AvatarImg }} />
          </div>
        ),
      )}
    </div>
  );
}
