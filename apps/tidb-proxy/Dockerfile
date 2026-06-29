# syntax=docker/dockerfile:1

ARG GO_VERSION=1.26
ARG ALPINE_VERSION=3.24

# ---- Go build (tsnet forwarder) ----
# BUILDPLATFORM でホスト側 Go ツールチェーンを使い、TARGETARCH で Fargate (ARM64)
# 向けにクロスコンパイル。CGO_ENABLED=0 で完全 static 化。
FROM --platform=$BUILDPLATFORM golang:${GO_VERSION}-alpine AS go-builder
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download
COPY cmd ./cmd
ARG TARGETOS=linux
ARG TARGETARCH=arm64
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags="-s -w" -o /out/tidb-forwarder ./cmd/forwarder

# ---- Runtime ----
FROM alpine:${ALPINE_VERSION}

RUN apk add --no-cache \
        ca-certificates \
        squid \
        tini \
        jq \
        netcat-openbsd \
    && rm -rf /var/cache/apk/* \
    # squid のデフォルト state ディレクトリを準備 (cache_dir は未使用だが access.log 等の出力先)
    && mkdir -p /var/log/squid /var/cache/squid /var/lib/tsnet-state \
    && chown -R squid:squid /var/log/squid /var/cache/squid

COPY --from=go-builder /out/tidb-forwarder /usr/local/bin/tidb-forwarder
COPY squid.conf /etc/squid/squid.conf
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 13306 3128

# tini を PID 1 にして child を確実に reap、SIGTERM を子プロセスへ伝搬。
ENTRYPOINT ["/sbin/tini", "-g", "--"]
CMD ["/usr/local/bin/entrypoint.sh"]
