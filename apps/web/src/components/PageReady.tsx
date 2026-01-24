'use client';

import { useEffect } from 'react';
import { useNavigationProgress } from '@/components/NavigationProgressProvider';

/**
 * ページ描画完了を通知するコンポーネント
 * 各ページの末尾に配置して、コンテンツ描画後にナビゲーションプログレスを完了させる
 */
export function PageReady() {
  const { doneProgress } = useNavigationProgress();

  useEffect(() => {
    // Wait for browser to paint the content
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        doneProgress();
      });
    });
  }, [doneProgress]);

  return null;
}
