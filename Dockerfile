# syntax=docker/dockerfile:1.7
# v0.1 MVP 用单阶段构建 + tsx 跑 TypeScript。
# pnpm workspace symlink 在多阶段复制时会断，所以不用 builder/runtime 分离。
# v0.2 再考虑 tsup/esbuild 单文件打包以缩小镜像。

FROM node:20-alpine
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate \
 && apk add --no-cache python3 make g++ tini

WORKDIR /app

# 先复制依赖描述文件以最大化层缓存
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile

# 源码（放在依赖层之后，变更更频繁）
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api

ENV NODE_ENV=production
ENV DATABASE_URL=file:/app/data/booknest.db
ENV PORT=3000

EXPOSE 3000

# tini 转发信号；--import=tsx/esm 让 Node 直接跑 .ts
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "pnpm --filter @booknest/api build:css && node --import=tsx/esm apps/api/src/db/migrate.ts && node --import=tsx/esm apps/api/src/server.ts"]
