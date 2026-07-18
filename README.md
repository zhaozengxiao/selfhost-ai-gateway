# AI Gateway

基于 **Node.js + Hono + SQLite** 的 AI 提供商 API 代理网关，统一 `/v1` 接口转发，支持多 Key 轮询、健康检查、自动故障转移、Key 级限流配额、用量统计与 Prometheus 指标。**完全 Docker 化，单容器即可运行**。

## 功能与特性

- **统一 API 接口** — 所有 AI 提供商通过 `https://你的域名/v1` 访问，兼容 OpenAI / Anthropic 协议
- **多 Key 轮询 + 健康检查** — 每个提供商可配置多个 API Key，请求随机打乱；失败 Key 自动降权，连续失败 5 次后进入冷却
- **Key 自动恢复** — 降权 Key 冷却 5 分钟后自动获得一次试用机会，成功则恢复权重，失败则重新冷却
- **流式响应透传** — SSE 流式响应直接透传 ReadableStream，不缓冲，延迟低
- **Key 级限流配额** — 每个 `sk_cf_*` 可独立配置 RPM（每分钟请求数）、dailyQuota（每日请求上限）、allowedModels（模型白名单）
- **用量统计与日志** — 每次转发记录状态码、耗时、token 消耗、错误信息，支持按 Key / 按提供商聚合
- **Prometheus 指标** — 内置 `/metrics` 端点，暴露请求计数、token 计数、耗时直方图、限流命中数
- **多提供商管理** — 内置 DeepSeek / OpenAI / Anthropic / Gemini，支持自定义添加
- **两级启用控制** — 提供商级别 + 模型级别的启用/禁用
- **转发 Key 认证** — 生成 `sk_cf_*` 格式的 API Key，支持有效期管理
- **模型连接测试** — 管理后台手动测试模型是否可连接（通过服务端代理，无跨域限制）
- **管理后台** — 卡片式 UI，移动端自适应，无需前端构建

## 技术栈

- **运行时**：Node.js 22+
- **框架**：[Hono](https://hono.dev/) v4 + `@hono/node-server`
- **存储**：SQLite ([better-sqlite3](https://github.com/WiseLibs/better-sqlite3))，WAL 模式
- **指标**：[prom-client](https://github.com/siimon/prom-client)
- **语言**：TypeScript（严格模式）

## 快速开始（Docker，推荐）

```bash
git clone <你的仓库地址>
cd ai-gateway

# 修改 docker-compose.yml 中的 ADMIN_USERNAME / ADMIN_PASSWORD
docker compose up -d --build
```

服务启动后：

- 首页：<http://localhost:8787/>
- 管理后台：<http://localhost:8787/admin/login>（用 compose 中配置的账号登录）
- API 基址：<http://localhost:8787/v1>
- Prometheus 指标：<http://localhost:8787/metrics>

数据持久化在 Docker 卷 `ai-gateway-data`，容器升级不丢数据。

### 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `ADMIN_USERNAME` | — | 管理后台用户名（必填） |
| `ADMIN_PASSWORD` | — | 管理后台密码（必填） |
| `PORT` | `8787` | 监听端口 |
| `DB_PATH` | `/app/data/ai-gateway.db` | SQLite 文件路径 |
| `USAGE_LOG_RETENTION_DAYS` | `90` | 用量日志保留天数 |
| `METRICS_TOKEN` | — | 可选，保护 `/metrics` 的 Bearer Token |
| `NODE_ENV` | — | 设为 `production` 时启用 Cookie secure 标记 |

## 本地开发（不用 Docker）

```bash
npm install

# 创建 .env（已 .gitignore）
cat > .env <<EOF
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your-password
PORT=8787
DB_PATH=./data/ai-gateway.db
EOF

# 启动开发服务器（热重载）
npm run dev

# 或编译后启动
npm run build
npm start
```

## 使用方法

- **API BASE URL**：`https://你的域名/v1`
- **API KEY**：在管理后台手动生成，格式为：`sk_cf_<KEY>`
- **模型ID**：`提供商ID/模型ID`，提供商ID在设置中自定义，如：
  - `deepseek/deepseek-chat`
  - `openai/gpt-4o`
  - `anthropic/claude-sonnet-4-20250514`

### curl 示例

```bash
curl https://你的域名/v1/chat/completions \
  -H "Authorization: Bearer sk_cf_xxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openai/gpt-4o",
    "messages": [{"role":"user","content":"hi"}],
    "stream": false
  }'
```

## 项目结构

```
ai-gateway/
├── src/
│   ├── index.ts       # 入口，路由注册 + @hono/node-server 启动 + 定期清理任务
│   ├── types.ts       # 类型定义（Env / Provider / ProxyKey / UsageLog）
│   ├── config.ts      # 默认配置 + 环境变量
│   ├── db.ts          # SQLite 初始化 + schema 迁移
│   ├── storage.ts     # SQLite 存储层（CRUD + 健康检查 + 限流计数 + 用量日志）
│   ├── auth.ts        # Session 认证 + Proxy Key 鉴权 + RPM/日配额限流
│   ├── proxy.ts       # API 转发核心（Key 轮询 + 健康检查 + 流式透传 + 用量记录）
│   ├── admin.ts       # 管理 API（含用量统计 API）
│   ├── metrics.ts     # Prometheus 指标 + /metrics 端点
│   ├── pages.ts       # 前端页面模板
│   ├── pages.css.ts   # 样式
│   └── shared.js.ts   # 共享 JS 工具函数
├── Dockerfile
├── docker-compose.yml
├── package.json
└── tsconfig.json
```

## 数据库 schema

| 表 | 用途 |
|----|------|
| `providers` | 提供商配置（apiKeys / models 以 JSON 存储） |
| `sessions` | 管理后台 Session |
| `proxy_keys` | 转发 Key（含 rpm / dailyQuota / allowedModels） |
| `key_health` | 上游 API Key 健康状态（失败次数、降权时间） |
| `usage_logs` | 每次转发的用量日志（含 token、耗时、错误） |
| `rate_counters` | 限流计数器（RPM 窗口 + daily 窗口） |

所有表都通过 `db.ts` 的 `applyMigrations` 幂等创建，首次启动自动建表。

## License

Apache 2.0
