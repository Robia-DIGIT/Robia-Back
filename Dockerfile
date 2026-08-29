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

COPY prisma.config.ts ./
COPY prisma ./prisma
CMD ["npx", "prisma", "migrate", "deploy"]

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PORT=3001

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./package.json

USER node

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:3001/health').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"]

CMD ["node", "dist/src/main"]
