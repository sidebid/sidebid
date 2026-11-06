# Production image: the server and the built site, nothing else. No validator and no test keys.
# Needs a persistent volume: on Railway DATA_DIR defaults to its mount path, and the server refuses to start without one.

# ---- the site, built here so web/dist always matches the commit
FROM node:24-bookworm-slim AS web
WORKDIR /app
COPY web/package.json web/package-lock.json web/
RUN cd web && npm ci
COPY program/idl program/idl
COPY web/build.mjs web/
COPY web/src web/src
COPY web/brand web/brand
RUN cd web && npm run build && rm -rf test

# ---- the server
FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY server/package.json server/package-lock.json server/
RUN cd server && npm ci --omit=dev && npm cache clean --force
COPY server/src server/src
COPY server/idl server/idl
COPY server/tools server/tools
COPY web/brand web/brand
COPY web/log.json web/log.json
COPY --from=web /app/web/dist web/dist
# Runs as root: volumes are commonly mounted owned by root, and the database lives on the volume
CMD ["node", "server/src/index.mjs"]
