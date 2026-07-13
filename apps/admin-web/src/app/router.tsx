import { createRouter } from '@tanstack/react-router';

import { routeTree } from './routeTree.gen';

// ルート定義は file-based routing (flat routes)。実体は app/routes/*.tsx で、
// tanstackRouter プラグインが routeTree.gen.ts を生成する (vite.config.ts 参照)
export const router = createRouter({ routeTree });

export { routeTree };

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
