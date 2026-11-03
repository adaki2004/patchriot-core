# Build without application credentials. Dependencies and base images are pinned.
FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS web
WORKDIR /source/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --ignore-scripts
COPY web/index.html web/tsconfig.json web/vite.config.ts ./
COPY web/src ./src
COPY web/public ./public
RUN npm run build

FROM rust:1.94.1-alpine@sha256:77237dd363a0b127bb5ef532c2d64c0deb380b738e43a9c4bdac73398d6d0a08 AS rust
RUN apk add --no-cache musl-dev gcc
WORKDIR /source
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates ./crates
RUN cargo build --locked --release -p patchriot-core

FROM alpine:3.23@sha256:ff7f0c727dd796aa36787bfcd9a64bf35a6ce72a73451b3359fde849b6703d63
RUN apk add --no-cache ca-certificates
COPY --from=rust /source/target/release/patchriot-core /usr/local/bin/patchriot-core
COPY --from=web /source/web/dist /app/web
COPY --chmod=755 deploy/start-core.sh /app/start-core.sh
USER 65534:65534
ENV PATCHRIOT_WEB_ROOT=/app/web
EXPOSE 8080
ENTRYPOINT ["/app/start-core.sh"]
CMD ["serve"]
