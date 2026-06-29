#!/bin/sh
# tidb-proxy container entrypoint
#
# squid (HTTP forward proxy) と tidb-forwarder (tsnet TCP forward) を並走させる。
# どちらかが死んだら exit して container ごと ECS に再起動させる。
# tini (-g) が PID 1 で signal を子プロセスへ伝搬する前提。

set -eu

cleanup() {
    pids=$(jobs -p 2>/dev/null || true)
    if [ -n "${pids}" ]; then
        # shellcheck disable=SC2086
        kill -TERM ${pids} 2>/dev/null || true
    fi
}
trap cleanup TERM INT EXIT

# squid 6.x は root を拒否するため非特権 "squid" user に drop する。container の
# /dev/stdout / /dev/stderr は PID 1 (root) 所有なので、squid user から fopen
# できるよう mode を緩める。symlink を辿った先 (/proc/self/fd/N) を chmod する。
chmod 0666 /dev/stdout /dev/stderr 2>/dev/null || true

# squid を foreground (-N) で起動。debug は cache_log (/dev/stderr) 側で出すので
# `-d` は付けない (両方有効にすると同じ行が 2 回出る)。
squid -N -f /etc/squid/squid.conf &
SQUID_PID=$!
echo "entrypoint: squid started pid=${SQUID_PID}"

# forwarder は env を main.go 側で読む
/usr/local/bin/tidb-forwarder &
FORWARDER_PID=$!
echo "entrypoint: tidb-forwarder started pid=${FORWARDER_PID}"

# busybox ash の wait -n は v1.30 以降サポートだが、portable に書くため
# polling で「片方でも死んだら exit」を実装する。
while kill -0 "${SQUID_PID}" 2>/dev/null && kill -0 "${FORWARDER_PID}" 2>/dev/null; do
    sleep 5
done

if ! kill -0 "${SQUID_PID}" 2>/dev/null; then
    echo "entrypoint: squid (pid=${SQUID_PID}) exited" >&2
else
    echo "entrypoint: tidb-forwarder (pid=${FORWARDER_PID}) exited" >&2
fi

# 残っている方も止めて exit。Fargate 側で task が再起動する。
kill -TERM "${SQUID_PID}" "${FORWARDER_PID}" 2>/dev/null || true
wait 2>/dev/null || true
exit 1
