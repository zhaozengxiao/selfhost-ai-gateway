# ===== 构建阶段 =====
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# better-sqlite3 是原生模块，需要构建工具链
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# 重新安装生产依赖（剔除 devDependencies，并按目标平台重建原生模块）
RUN npm ci --omit=dev

# ===== 运行阶段 =====
FROM node:22-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production \
    PORT=8787 \
    DB_PATH=/app/data/ai-gateway.db

# better-sqlite3 运行时需要 libc（slim 镜像已具备）
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json

# 数据卷
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/admin/api/status',{headers:{'accept':'application/json'}}).then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
