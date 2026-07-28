/// <reference types="bun" />
// turbo dev (ルートの `bun run dev`) から 1 タスクでプレビュー一式を立ち上げるための起動スクリプト。
// モック API (server.ts, LABS_API_PORT) を同一プロセスで起動しつつ、vite dev (LABS_WEB_PORT) を子プロセスで起動する
import './server.ts';

const vite = Bun.spawn(['bun', 'run', 'dev:web'], {
  cwd: new URL('..', import.meta.url).pathname,
  stdio: ['inherit', 'inherit', 'inherit'],
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    vite.kill(signal);
  });
}

process.exit(await vite.exited);
