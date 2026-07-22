'use client';

import type { MouseEvent } from 'react';
import { useEffect, useRef, useState } from 'react';

interface TocHeading {
  id: string;
  text: string;
  level: number;
}

interface TocNode extends TocHeading {
  children: TocNode[];
}

// tocbot 相当の追従判定オフセット。見出しがこのラインを越えたらアクティブ扱い
const HEADINGS_OFFSET = 100;

// location.hash はパーセントエンコードされたまま返るため、
// 日本語見出し ID と突き合わせるにはデコードが必要
function decodeHashId(hash: string): string {
  try {
    return decodeURIComponent(hash.replace(/^#/, ''));
  } catch {
    return hash.replace(/^#/, '');
  }
}

function buildTree(headings: TocHeading[]): TocNode[] {
  const root: TocNode[] = [];
  const stack: { level: number; children: TocNode[] }[] = [{ level: 0, children: root }];
  for (const heading of headings) {
    const node: TocNode = { ...heading, children: [] };
    while (stack.length > 1 && heading.level <= stack[stack.length - 1].level) {
      stack.pop();
    }
    stack[stack.length - 1].children.push(node);
    stack.push({ level: heading.level, children: node.children });
  }
  return root;
}

function TocList({ nodes, activeId }: { nodes: TocNode[]; activeId: string | null }) {
  return (
    <ol className="toc-list">
      {nodes.map((node, index) => (
        <li
          key={`${node.id}-${index}`}
          className={node.id === activeId ? 'toc-list-item is-active-li' : 'toc-list-item'}
        >
          <a
            className={node.id === activeId ? 'toc-link is-active-link' : 'toc-link'}
            href={`#${node.id}`}
          >
            {node.text}
          </a>
          {node.children.length > 0 && <TocList nodes={node.children} activeId={activeId} />}
        </li>
      ))}
    </ol>
  );
}

export function TableOfContents() {
  const [headings, setHeadings] = useState<TocHeading[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const mobileListRef = useRef<HTMLDivElement>(null);
  const desktopRef = useRef<HTMLDivElement>(null);

  // 本文はツイート埋め込みで複数の .prose に分割されるため、全体を包むラッパーを見る
  useEffect(() => {
    const content = document.querySelector('.article-content-wrapper');
    if (!content) return;

    const elements = content.querySelectorAll('h1, h2, h3');
    const items: TocHeading[] = [];
    elements.forEach((element, index) => {
      // 旧コンバータ時代の content_html は見出しに ID が無いためフォールバックを振る
      if (!element.id) {
        element.id = `heading-${index}`;
      }
      // 見出し内のアンカー要素（heading-anchor の # と comrak の空 anchor）はラベルに含めない
      const text = Array.from(element.childNodes)
        .filter(
          (node) =>
            !(
              node instanceof Element &&
              (node.classList.contains('heading-anchor') || node.classList.contains('anchor'))
            ),
        )
        .map((node) => node.textContent ?? '')
        .join('')
        .trim();
      items.push({
        id: element.id,
        text,
        level: Number(element.tagName.charAt(1)),
      });
    });
    setHeadings(items);
  }, []);

  // スクロール位置からアクティブ見出しを追従する
  useEffect(() => {
    if (headings.length === 0) return;

    let rafId = 0;
    const update = () => {
      rafId = 0;

      // ページ最下部で止まった場合、スクロールでは到達できない見出しでも
      // hash が指していればそちらを優先してアクティブにする
      const atBottom =
        window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
      if (atBottom) {
        const hashId = decodeHashId(window.location.hash);
        if (hashId && headings.some((h) => h.id === hashId)) {
          setActiveId(hashId);
          return;
        }
      }

      let currentId: string | null = null;
      for (const heading of headings) {
        const element = document.getElementById(heading.id);
        if (!element) continue;
        if (element.getBoundingClientRect().top <= HEADINGS_OFFSET) {
          currentId = heading.id;
        } else {
          break;
        }
      }
      setActiveId(currentId ?? headings[0].id);
    };

    const onScroll = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(update);
    };

    update();
    document.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      document.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [headings]);

  // アクティブ項目が目次ペインの表示範囲外に出たらペイン内スクロールで追従する
  // （scrollIntoView はページ側まで動かすことがあるため scrollTop を直接調整する）
  useEffect(() => {
    const pane = desktopRef.current;
    const link = pane?.querySelector('.is-active-link');
    if (!pane || !link) return;

    const paneRect = pane.getBoundingClientRect();
    const linkRect = link.getBoundingClientRect();
    if (linkRect.top < paneRect.top) {
      pane.scrollTop += linkRect.top - paneRect.top;
    } else if (linkRect.bottom > paneRect.bottom) {
      pane.scrollTop += linkRect.bottom - paneRect.bottom;
    }
  }, [activeId]);

  // クリック直後にアクティブを確定させる（スクロール追従を待つとちらつくため）
  const handleTocClick = (event: MouseEvent) => {
    const link = (event.target as Element).closest('a');
    if (!link) return;
    setActiveId(decodeHashId(link.getAttribute('href') ?? ''));
  };

  // 見出しへ移動したらモーダルを閉じて本文を見せる。背景クリックでも閉じる
  const handleDialogClick = (event: MouseEvent) => {
    handleTocClick(event);
    if (event.target === dialogRef.current || (event.target as Element).closest('a')) {
      dialogRef.current?.close();
    }
  };

  const tree = buildTree(headings);

  return (
    <>
      <button
        type="button"
        className="toc-mobile-trigger"
        aria-label="目次を開く"
        onClick={() => {
          dialogRef.current?.showModal();
          // dialog は最初のリンクへ自動フォーカスし、block リンクの
          // フォーカスリングが下線のように見えるため、リスト全体へ移す
          mobileListRef.current?.focus();
        }}
      >
        目次
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>
      <dialog ref={dialogRef} className="toc-mobile-dialog" onClick={handleDialogClick}>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: dialog 内の初期フォーカス受け皿 */}
        <div ref={mobileListRef} tabIndex={-1} className="toc toc-mobile-list">
          {tree.length > 0 && <TocList nodes={tree} activeId={activeId} />}
        </div>
      </dialog>
      <div ref={desktopRef} className="toc toc-desktop" onClick={handleTocClick}>
        {tree.length > 0 && <TocList nodes={tree} activeId={activeId} />}
      </div>
    </>
  );
}
