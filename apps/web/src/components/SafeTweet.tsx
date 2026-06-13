'use client';

import { Component, type ComponentProps, type ReactNode, useEffect, useRef } from 'react';
import { Tweet } from 'react-tweet';

interface SafeTweetProps {
  id: string;
  components?: ComponentProps<typeof Tweet>['components'];
}

interface TweetErrorBoundaryProps {
  id: string;
  children: ReactNode;
}

interface TweetErrorBoundaryState {
  hasError: boolean;
}

class TweetErrorBoundary extends Component<TweetErrorBoundaryProps, TweetErrorBoundaryState> {
  state: TweetErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): TweetErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    console.error(`Tweet render failed (id=${this.props.id}):`, error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <a
          className="tweet-fallback"
          href={`https://x.com/i/status/${this.props.id}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          View this post on X
        </a>
      );
    }
    return this.props.children;
  }
}

// video.twimg.com は Referer ホワイトリスト（x.com 系のみ）で、localhost / 自ドメインからの
// <video> リクエストを 403 で弾く。HTML 仕様上 <video> に referrerpolicy 属性が無いため
// 後付けでは効かない。代わりに <source> の URL を fetch({referrerPolicy:'no-referrer'}) で
// 取得して blob URL に差し替え、ブラウザに Referer 無しでバイト列を渡してから再生させる。
function useTweetVideoBlobRewrite(rootRef: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let blobUrl: string | null = null;

    const rewrite = async (source: HTMLSourceElement) => {
      if (!source.src.startsWith('https://video.twimg.com/')) return;
      if (source.dataset.blobRewrite) return;
      source.dataset.blobRewrite = '1';
      try {
        const res = await fetch(source.src, { referrerPolicy: 'no-referrer' });
        if (!res.ok) return;
        blobUrl = URL.createObjectURL(await res.blob());
        source.src = blobUrl;
        source.closest('video')?.load();
      } catch {
        // 失敗時は元の src のまま放置。ブラウザ側で再生失敗を表示する
      }
    };

    const scan = (node: ParentNode) =>
      node.querySelectorAll<HTMLSourceElement>('video > source').forEach((s) => void rewrite(s));

    scan(root);

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node instanceof Element) scan(node);
        }
      }
    });
    observer.observe(root, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [rootRef]);
}

export function SafeTweet({ id, components }: SafeTweetProps) {
  const ref = useRef<HTMLDivElement>(null);
  useTweetVideoBlobRewrite(ref);

  return (
    <div ref={ref}>
      <TweetErrorBoundary id={id}>
        <Tweet id={id} components={components} />
      </TweetErrorBoundary>
    </div>
  );
}
