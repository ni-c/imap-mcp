# Build stage
#
# node:24-alpine is the ACTIVE LTS line, not the newest tag — roughly half of all
# Node majors never become LTS, so "newest" and "supported" are different things.
# What keeps this honest is a comparison, not a version number written down here:
# `node:lts-alpine` and `node:24-alpine` MUST resolve to the same digest. The day
# 24 leaves LTS they diverge, and that is visible; a hardcoded version in a comment
# is not. Verified 2026-09-01: both resolve to the digest below, Node 24.20.0.
# Refresh the digest and re-run that comparison together — a stale tag is
# invisible if only the digest is re-resolved.
FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

# Runtime
FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf
WORKDIR /app
ENV NODE_ENV=production

# The pinned digest is the newest node:24-alpine, and it still ships OpenSSL
# 3.5.7-r0 — CVE-2026-14456, unbounded memory growth, fixed in 3.5.8-r0. Named
# packages only: a blanket `apk upgrade` would move every package in the image
# and throw away the reproducibility the digest is pinned for. Drop this line
# once the base image carries 3.5.8-r0 or later.
RUN apk add --no-cache --upgrade libcrypto3 libssl3

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# The server reports its version from package.json at runtime.
COPY package.json package-lock.json ./

# The base image's bundled npm is a frequent source of HIGH findings and this
# image never installs anything — remove it rather than carrying its CVEs.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# Ownership proof for the MCP Registry: must match server.json's name exactly.
LABEL io.modelcontextprotocol.server.name="io.github.ni-c/imap-mcp"

# Drop root: the node image ships an unprivileged `node` user (uid 1000).
#
# Consequence worth knowing before you set IMAP_DOWNLOAD_DIR: attachments are
# written as uid 1000, so a bind-mounted host directory has to be
# `chown 1000:1000` on the HOST. Without IMAP_DOWNLOAD_DIR the server never
# touches the filesystem and this does not come up.
USER node

# stdio transport only — no port, no healthcheck. The server starts without
# credentials (tools stay listable, so registries and inspectors can introspect
# it); every call then fails with setup instructions instead of reaching a server.
ENTRYPOINT ["node", "dist/index.js"]
