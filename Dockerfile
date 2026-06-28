# syntax=docker/dockerfile:1

ARG RUST_VERSION=1.96
ARG GO_VERSION=1.26

# ---- Rust deps cache (cargo-chef) ----
FROM lukemathwalker/cargo-chef:latest-rust-${RUST_VERSION} AS chef
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM chef AS planner
COPY . .
RUN cargo chef prepare --recipe-path recipe.json

FROM chef AS rust-builder
COPY --from=planner /app/recipe.json recipe.json
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/usr/local/cargo/git,sharing=locked \
    cargo chef cook --release --recipe-path recipe.json

COPY . .
ARG APP_NAME=server

RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,target=/app/target,sharing=locked \
    cargo build --release --bin ${APP_NAME} && \
    cp ./target/release/${APP_NAME} /bin/server

# ---- Go build (tsnet-launcher) ----
# BUILDPLATFORM でホスト側 Go ツールチェーンを使い、TARGETARCH で Lambda 向けに
# クロスコンパイル。CGO_ENABLED=0 で完全 static にし distroless で動かす。
FROM --platform=$BUILDPLATFORM golang:${GO_VERSION}-bookworm AS go-builder
WORKDIR /src
COPY apps/blog-api/tsnet-launcher/go.mod apps/blog-api/tsnet-launcher/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download
COPY apps/blog-api/tsnet-launcher/ ./
ARG TARGETOS=linux
ARG TARGETARCH=arm64
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags="-s -w" -o /bin/tsnet-launcher .

# ---- AWS Lambda Web Adapter ----
FROM public.ecr.aws/awsguru/aws-lambda-adapter:0.9.0 AS aws-lambda-adapter

# ---- Runtime ----
FROM gcr.io/distroless/cc-debian13:nonroot
COPY --from=aws-lambda-adapter /lambda-adapter /opt/extensions/lambda-adapter

WORKDIR /app
COPY --from=rust-builder --chown=nonroot:nonroot /bin/server /app/server
COPY --from=go-builder --chown=nonroot:nonroot /bin/tsnet-launcher /app/tsnet-launcher
USER nonroot

EXPOSE 8080
# tsnet-launcher が Tailnet 接続を確立してから /app/server を子プロセスで起動する
CMD ["/app/tsnet-launcher"]
