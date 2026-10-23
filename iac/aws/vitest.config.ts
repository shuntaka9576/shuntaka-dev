import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // スタックの synth (cdk-nag とテンプレート検証を含む) は 1 件で数秒かかり、CI で cargo の
    // ビルドと並行すると既定の 5 秒を超えるため延ばす
    testTimeout: 30_000,
  },
});
