import { ulid } from 'ulid';
import { requireEnv } from '../env.js';

export const newImageKey = (): string => `images/moments/${ulid()}.webp`;

// thumb の key は orig から機械的に導出する (DB には orig のみ保存)
export const thumbKey = (imageKey: string): string => imageKey.replace(/\.webp$/, '_thumb.webp');

// 配信 URL は stage 設定 (IMAGES_BASE_URL, 例: https://images.shuntaka.tech) から組み立てる
export const imageUrl = (key: string): string => `${requireEnv('IMAGES_BASE_URL')}/${key}`;
