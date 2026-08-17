# opendb-dsh: one image, two profiles (host / runtime). dsh pinned to 0.1.0-rc.6 via workspace devDependency.
FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates git \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@11 --activate
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini && rm -rf /var/lib/apt/lists/*
ENV DSH_HOME=/var/lib/dsh
WORKDIR /app
COPY --from=build /src /app
# Pre-bake profile dirs + profiles/node_modules symlinks (dsh rewrites cordis.yml at every start; dirs must be writable)
RUN mkdir -p $DSH_HOME/profiles \
 && ln -s /app/profiles/host $DSH_HOME/profiles/host \
 && ln -s /app/profiles/runtime $DSH_HOME/profiles/runtime \
 && OPENDB_PG_URL=x node_modules/.bin/dsh --profile host --dump-config >/dev/null \
 && OPENDB_PG_URL=x node_modules/.bin/dsh --profile runtime --dump-config >/dev/null \
 && chown -R node:node /app $DSH_HOME
USER node
ENV DSH_TELEMETRY_DISABLED=1 DSH_PERMISSION_MODE=read-only
ENTRYPOINT ["tini","--","node_modules/.bin/dsh"]
CMD ["--profile","host"]
