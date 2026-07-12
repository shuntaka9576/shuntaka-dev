import fsd from '@feature-sliced/steiger-plugin';
import { defineConfig } from 'steiger';

export default defineConfig([
  ...fsd.configs.recommended,
  // shared はセグメント単位で import するため public-api ルールを緩和する
  {
    files: ['./src/shared/**'],
    rules: { 'fsd/public-api': 'off' },
  },
  // session / moment はドメインの基礎データとして entity に置く。参照スライスが
  // まだ少なく insignificant-slice が誤検出するため緩和する
  {
    files: ['./src/entities/session/**', './src/entities/moment/**'],
    rules: { 'fsd/insignificant-slice': 'off' },
  },
  // moment-form は投稿ページ専用の複合フォーム (画像圧縮 + presign + 投稿) として
  // 意図的に feature 化している。参照元が pages/moment-new のみのため緩和する
  {
    files: ['./src/features/moment-form/**'],
    rules: { 'fsd/insignificant-slice': 'off' },
  },
  // 設定ファイル・生成物はアーキテクチャ解析の対象外
  {
    ignores: ['**/*.config.*', '**/routeTree.gen.ts'],
  },
]);
