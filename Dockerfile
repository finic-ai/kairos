# One image: the API and the built console, served from the same port. It needs a Postgres
# (DATABASE_URL); docker-compose.yml starts one next to it.

FROM node:22-slim AS build
WORKDIR /repo
RUN npm install -g pnpm@10
# The packages are downloaded from the lockfile alone, so a change to the code does not download them again.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
RUN pnpm install --frozen-lockfile --offline
RUN pnpm build:standalone

FROM node:22-slim
ENV NODE_ENV=production \
    PORT=8787 \
    KAIROS_MIGRATIONS=/app/drizzle \
    KAIROS_TEMPLATES=/app/templates \
    KAIROS_CONSOLE=/app/console
WORKDIR /app
# Nothing here runs npm, and its bundled packages are most of the image's vulnerability findings.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
# The server is one file, so the image has no node_modules.
COPY --from=build /repo/apps/server/dist ./
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://localhost:' + process.env.PORT + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "server.mjs"]
