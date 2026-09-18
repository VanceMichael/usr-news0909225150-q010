# 临时海域禁入判定服务 —— 纯后端镜像
# 使用 bookworm-slim（glibc）：验收阶段的用户态 PostgreSQL 测试二进制
# 不兼容 Alpine 的 musl。
FROM node:22-bookworm-slim AS base
WORKDIR /app

# 先装依赖，利用层缓存。
COPY package.json package-lock.json ./
RUN npm ci

# 拷贝源码与契约/夹具并构建。
COPY tsconfig.json tsconfig.test.json ./
COPY contracts ./contracts
COPY fixtures ./fixtures
COPY scaffold ./scaffold
COPY src ./src
COPY test ./test
RUN npm run build \
    && npm run domain:check \
    && chown -R node:node /app

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

USER node

# 默认启动 API 服务；迁移在进程启动时自动执行。
# 验收容器以 command 覆盖为 npm run test:acceptance。
CMD ["node", "dist/server.js"]
