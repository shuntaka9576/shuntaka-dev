import type { InferResponseType } from 'hono/client';

import { client } from '@/shared/api';

// 型は RPC レスポンスから導出する (backend の zod スキーマを runtime import しない)
export type Moment = InferResponseType<typeof client.api.moments.$get, 200>['items'][number];

export type Fastener = Moment['fastener'];
export type FastenerColor = NonNullable<Moment['fastenerColor']>;
export type MomentStatus = Moment['status'];

export const fastenerLabels: Record<Fastener, string> = {
  clip: 'クリップ',
  tape: 'テープ',
};

export const fastenerColorLabels: Record<FastenerColor, string> = {
  pink: 'ピンク',
  blue: 'ブルー',
  yellow: 'イエロー',
  green: 'グリーン',
};

export const momentStatusLabels: Record<MomentStatus, string> = {
  published: '公開',
  draft: '下書き',
};

export const fastenerOptions: { value: Fastener; label: string }[] = [
  { value: 'clip', label: fastenerLabels.clip },
  { value: 'tape', label: fastenerLabels.tape },
];

export const fastenerColorOptions: { value: FastenerColor; label: string }[] = [
  { value: 'pink', label: fastenerColorLabels.pink },
  { value: 'blue', label: fastenerColorLabels.blue },
  { value: 'yellow', label: fastenerColorLabels.yellow },
  { value: 'green', label: fastenerColorLabels.green },
];
