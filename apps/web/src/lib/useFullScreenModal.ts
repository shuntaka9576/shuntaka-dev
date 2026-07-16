'use client';

import { useEffect, useState } from 'react';

interface ViewportMetrics {
  height: number;
  offsetTop: number;
}

/**
 * 全画面モーダル (fixed inset-x-0) の共通 chrome。
 *
 * - `visualViewport` の height / offsetTop を追随して返す (keyboard 起動時の押し出し対応)。
 * - body の overflow をロックして背景スクロールを止める。
 * - Escape で `onClose` を呼ぶ。
 *
 * 返り値の `containerStyle` を `<div style={containerStyle}>` に直接渡す。
 * visualViewport 非対応環境では `{ top: 0, height: '100dvh' }` にフォールバックする。
 */
export function useFullScreenModal(
  open: boolean,
  onClose: () => void,
): { containerStyle: React.CSSProperties } {
  const [viewport, setViewport] = useState<ViewportMetrics | null>(null);

  useEffect(() => {
    if (!open) return;
    const vp = window.visualViewport;
    if (!vp) return;
    const update = () => setViewport({ height: vp.height, offsetTop: vp.offsetTop });
    update();
    vp.addEventListener('resize', update);
    vp.addEventListener('scroll', update);
    return () => {
      vp.removeEventListener('resize', update);
      vp.removeEventListener('scroll', update);
      setViewport(null);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  const containerStyle: React.CSSProperties = viewport
    ? { top: viewport.offsetTop, height: viewport.height }
    : { top: 0, height: '100dvh' };

  return { containerStyle };
}
