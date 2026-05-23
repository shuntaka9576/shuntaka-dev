'use client';

import { Component, type ComponentProps, type ReactNode } from 'react';
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

export function SafeTweet({ id, components }: SafeTweetProps) {
  return (
    <TweetErrorBoundary id={id}>
      <Tweet id={id} components={components} />
    </TweetErrorBoundary>
  );
}
