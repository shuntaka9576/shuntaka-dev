// Lambda Web Functions のエントリ。ランタイムは Node.js のみのため、同梱した Rust (Axum) の
// server バイナリを子プロセスで起動するだけで、HTTP は Rust が AWS_LAMBDA_HTTP_ENDPOINT で直接待ち受ける。
// env を渡さないので環境変数は子にそのまま引き継がれる
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const server = spawn(fileURLToPath(new URL('./server', import.meta.url)), { stdio: 'inherit' });

// Lambda は環境を消す前に SIGTERM を送ってくるので子に転送する
process.on('SIGTERM', () => server.kill('SIGTERM'));

server.on('exit', (code, signal) => {
  console.log(`server exited (code=${code}, signal=${signal})`);
  // 転送した SIGTERM で止まったのは正常な終了。1 で抜けると spinDownReport が Runtime.ExitError になる
  process.exit(signal === 'SIGTERM' ? 0 : (code ?? 1));
});

server.on('error', (err) => {
  console.error(err);
  process.exit(1);
});
