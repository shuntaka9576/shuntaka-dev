# syntax=docker/dockerfile:1

ARG RUST_VERSION=1.94

FROM lukemathwalker/cargo-chef:latest-rust-${RUST_VERSION} AS chef
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM chef AS planner
COPY . .
RUN cargo chef prepare --recipe-path recipe.json

FROM chef AS builder
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

FROM public.ecr.aws/awsguru/aws-lambda-adapter:0.9.0 AS aws-lambda-adapter

FROM gcr.io/distroless/cc-debian13:nonroot
COPY --from=aws-lambda-adapter /lambda-adapter /opt/extensions/lambda-adapter

WORKDIR /app
COPY --from=builder --chown=nonroot:nonroot /bin/server /app
USER nonroot

EXPOSE 8080
CMD ["/app/server"]
