// Lambda Web Functions のエントリ。standalone の server.js を起動する
import { createRequire } from 'node:module';

// Lambda は待ち受け先を AWS_LAMBDA_HTTP_ENDPOINT (host:port) で渡すが、
// standalone の server.js は HOSTNAME と PORT を読むので変換する。未設定はローカル実行時のみ
const address = process.env.AWS_LAMBDA_HTTP_ENDPOINT ?? 'localhost:3000';
const separator = address.lastIndexOf(':');
process.env.HOSTNAME = address.slice(0, separator);
process.env.PORT = address.slice(separator + 1);

// server.js は CommonJS。outputFileTracingRoot をリポジトリのルートにしているので apps/web/ 配下に出る
createRequire(import.meta.url)('./apps/web/server.js');
