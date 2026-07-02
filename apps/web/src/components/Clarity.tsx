'use client';

import ClarityScript from '@microsoft/clarity';
import { useEffect } from 'react';
import { CLARITY_PROJECT_ID, isClarityEnabled } from '@/lib/clarity';

export function Clarity() {
  useEffect(() => {
    if (!isClarityEnabled()) return;
    ClarityScript.init(CLARITY_PROJECT_ID);
  }, []);

  return null;
}
