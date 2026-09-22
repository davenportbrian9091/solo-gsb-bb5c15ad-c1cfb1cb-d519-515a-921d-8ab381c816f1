# ---- 构建阶段：预装工具链，保证 better-sqlite3 即使下载不到预编译二进制也能源码编译 ----
FROM node:20-slim AS build

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

# ---- 运行阶段：slim 镜像 + 已构建好的依赖 ----
FROM node:20-slim

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/app/data

COPY --from=build /app/node_modules ./node_modules
COPY server ./server
COPY public ./public

RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server/index.js"]
