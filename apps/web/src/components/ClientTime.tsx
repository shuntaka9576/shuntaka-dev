'use client';

import { useEffect, useState } from 'react';

export function ClientTime() {
  const [time, setTime] = useState<string>('');

  useEffect(() => {
    setTime(new Date().toLocaleTimeString('ja-JP'));
  }, []);

  return <span>{time || 'Loading...'}</span>;
}
