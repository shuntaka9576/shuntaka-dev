// Lambda Web Functions のエントリ。standalone の server.js を起動する
import dc from 'node:diagnostics_channel';
import http from 'node:http';
import { createRequire } from 'node:module';

// ---- cold start の判定 ----
// 初期化を待たされたリクエストは listen の直後にまとめて渡されるので、listen から COLD_START_WINDOW_MS 未満に
// 受けたリクエストを cold start とする。「プロセス起動後の最初のリクエスト」では判定しない。Lambda は需要より
// 先に実行環境を立ち上げる (headroom) ため最初のリクエストでも待っていないことがあり、初期化中に並列で届いた
// 2 件目以降は待っていても数えられないため。判定と出力は blog-api (apps/blog-api/api/src/request_start.rs) と揃え、
// 実行環境ごとに app.ready、リクエストごとに app.request を 1 行ずつ出す。console.log は runtime が message に
// 包むため stdout に直接書く
const COLD_START_WINDOW_MS = 1000;
const startedAtMs = Math.round(performance.timeOrigin);
let readyAtMs;
let seq = 0;
let inFlight = 0;

const log = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);

dc.tracingChannel('net.server.listen').subscribe({
  asyncEnd({ server }) {
    if (readyAtMs !== undefined || !(server instanceof http.Server)) return;
    readyAtMs = Date.now();
    log({ type: 'app.ready', startedAtMs, readyAtMs, initMs: readyAtMs - startedAtMs });
  },
});

dc.subscribe('http.server.request.start', ({ request, response }) => {
  const receivedAtMs = Date.now();
  seq += 1;
  inFlight += 1;
  const requestSeq = seq;
  const requestInFlight = inFlight;
  const sinceReadyMs = readyAtMs === undefined ? null : receivedAtMs - readyAtMs;
  const coldStart = sinceReadyMs !== null && sinceReadyMs < COLD_START_WINDOW_MS;

  // close は送り終えたときにも、クライアントが切断したときにも来る
  response.once('close', () => {
    inFlight -= 1;
    log({
      type: 'app.request',
      coldStart: coldStart ? 1 : 0,
      sinceReadyMs,
      seq: requestSeq,
      inFlight: requestInFlight,
      method: request.method,
      path: (request.url ?? '').split('?')[0],
      status: response.statusCode,
      // body を送り終える (または切断される) まで
      durationMs: Date.now() - receivedAtMs,
      // レスポンスヘッダーの lambda-web-request-id と platform.requestComplete の requestId と同じ値
      requestId: request.headers['lambda-web-request-id'] ?? null,
      cfId: request.headers['x-amz-cf-id'] ?? null,
    });
  });
});

// Lambda は待ち受け先を AWS_LAMBDA_HTTP_ENDPOINT (host:port) で渡すが、
// standalone の server.js は HOSTNAME と PORT を読むので変換する。未設定はローカル実行時のみ
const address = process.env.AWS_LAMBDA_HTTP_ENDPOINT ?? 'localhost:3000';
const separator = address.lastIndexOf(':');
process.env.HOSTNAME = address.slice(0, separator);
process.env.PORT = address.slice(separator + 1);

// server.js は CommonJS。outputFileTracingRoot をリポジトリのルートにしているので apps/web/ 配下に出る
createRequire(import.meta.url)('./apps/web/server.js');
