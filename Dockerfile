# Ølbrygging portal + PocketBase backend in a single container.
# The pinned PocketBase binary is a glibc build, so use a Debian-based image
# (Alpine/musl will not run it). No npm runtime dependencies are needed; the
# app code only uses Node built-ins.
FROM node:25-bookworm-slim

# Keep in sync with the --pb-version pin in package.json.
ARG PB_VERSION=0.40.6

ENV NODE_ENV=production \
    COOKIE_SECURE=true \
    HOST=0.0.0.0 \
    PORT=3000 \
    PB_DATA_DIR=/pb-data \
    POCKETBASE_URL=http://127.0.0.1:8090

# ca-certificates is a "recommended" package on bookworm-slim and is not
# pulled in by --no-install-recommends; without it curl cannot do TLS.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl unzip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Bake the pinned PocketBase binary in so containers never download it at boot.
RUN curl -fsSL -o /tmp/pocketbase.zip \
      "https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_linux_amd64.zip" \
    && unzip -j /tmp/pocketbase.zip -d /app pocketbase \
    && chmod +x /app/pocketbase \
    && rm /tmp/pocketbase.zip

COPY server.mjs api.mjs pocketbase.mjs package.json ./
COPY public/ public/
COPY pb_hooks/ pb_hooks/
COPY pb_migrations/ pb_migrations/
COPY scripts/container-entrypoint.mjs scripts/container-entrypoint.mjs

# Only the portal port is exposed; PocketBase stays on loopback inside the container.
EXPOSE 3000
CMD ["node", "scripts/container-entrypoint.mjs"]