# Build the browser client and the shared Rust API.
FROM node:24-bookworm-slim AS web
WORKDIR /build
COPY package.json package-lock.json ./
COPY apps/desktop/package.json apps/desktop/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci
COPY apps/desktop apps/desktop
COPY packages/shared packages/shared
COPY public public
RUN npm run build

FROM rust:1-bookworm AS build
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY apps/api apps/api
# Cargo loads every workspace member's manifest, even when building only the API.
COPY apps/desktop/src-tauri apps/desktop/src-tauri
COPY packages/audio-engine packages/audio-engine
COPY packages/video-engine packages/video-engine
COPY packages/call-engine packages/call-engine
RUN cargo build -p disc-api --release --locked

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /build/target/release/disc-api /app/disc-api
COPY --from=web /build/apps/desktop/dist /app/web
# Owned by the API user, so a fresh named volume mounted here is writable.
RUN mkdir -p /app/data/uploads && chown -R 10001 /app/data
ENV API_BIND=0.0.0.0:3001 WEB_DIST=/app/web UPLOADS_DIR=/app/data/uploads
USER 10001
EXPOSE 3001
CMD ["/app/disc-api"]
