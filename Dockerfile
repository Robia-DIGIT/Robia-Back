FROM node:22-bookworm-slim AS dependencies

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build

COPY nest-cli.json tsconfig.json tsconfig.build.json prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM dependencies AS migrate

COPY --chown=node:node prisma.config.ts ./
COPY --chown=node:node prisma ./prisma
# hardening/prisma-migration-guard — never invoke `prisma migrate deploy`
# directly. DATABASE_URL (runtime) and DIRECT_URL (this stage's migration
# target, per prisma.config.ts) are two independently-configured env vars
# Prisma itself never cross-checks; a prior incident had them pointing at
# two different databases (QA vs production) with nothing catching it. This
# script is the mandatory gate — see docs/PRISMA_MIGRATION_GUARD.md. Do not
# bypass it with a direct `prisma migrate deploy`/`npx prisma ...` CMD here.
COPY --chown=node:node scripts/safe-prisma-migrate.cjs ./scripts/safe-prisma-migrate.cjs
# Runs as the same non-root user as the `runtime` stage: this stage still
# opens real network connections to production PostgreSQL, and a process
# with no legitimate need for UID 0 should never run as root.
USER node

CMD ["node", "/app/scripts/safe-prisma-migrate.cjs"]

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PORT=3001

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./package.json

# RC-33 hardening — the mount point for ODC_UPLOAD_DIR (docker-compose.production.yml
# maps a persistent named volume here). Created and owned by node:node before
# USER node so a fresh named volume, which Docker initializes with this
# directory's own content and permissions on first mount, is writable by the
# non-root runtime user from the very first start.
RUN mkdir -p /data/odc-uploads && chown node:node /data/odc-uploads

USER node

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:3001/health').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"]

CMD ["node", "dist/src/main"]
