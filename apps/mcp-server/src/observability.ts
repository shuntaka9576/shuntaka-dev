import type { MiddlewareHandler } from 'hono';

// apps/web (web-function/index.mjs) と blog-api (api/src/request_start.rs) と同じ形でログを出す。
// 実行環境ごとに app.ready、リクエストごとに app.request を 1 行ずつ出す。listen から COLD_START_WINDOW_MS 未満に
// 受けたリクエストを cold start とする (初期化を待たされたリクエストは listen の直後にまとめて渡されるため)。
// console.log は runtime が message に包むため stdout に直接書く
const COLD_START_WINDOW_MS = 1000;

export type Log = (record: Record<string, unknown>) => void;

export const stdoutLog: Log = (record) => {
  process.stdout.write(`${JSON.stringify(record)}\n`);
};

export const createRequestObserver = (log: Log = stdoutLog) => {
  const startedAtMs = Math.round(performance.timeOrigin);
  let readyAtMs: number | undefined;
  let seq = 0;
  let inFlight = 0;

  const markReady = () => {
    if (readyAtMs !== undefined) {
      return;
    }
    readyAtMs = Date.now();
    log({ type: 'app.ready', startedAtMs, readyAtMs, initMs: readyAtMs - startedAtMs });
  };

  const middleware: MiddlewareHandler = async (c, next) => {
    const receivedAtMs = Date.now();
    seq += 1;
    inFlight += 1;
    const requestSeq = seq;
    const requestInFlight = inFlight;
    const sinceReadyMs = readyAtMs === undefined ? null : receivedAtMs - readyAtMs;
    try {
      await next();
    } finally {
      inFlight -= 1;
      log({
        type: 'app.request',
        coldStart: sinceReadyMs !== null && sinceReadyMs < COLD_START_WINDOW_MS ? 1 : 0,
        sinceReadyMs,
        seq: requestSeq,
        inFlight: requestInFlight,
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        durationMs: Date.now() - receivedAtMs,
        requestId: c.req.header('lambda-web-request-id') ?? null,
        cfId: c.req.header('x-amz-cf-id') ?? null,
      });
    }
  };

  return { markReady, middleware };
};
