# AI Gateway Code Wiki

> 基于 **Node.js + Hono + SQLite** 的 AI 提供商 API 代理网关

---

## 目录

1. [项目概述](#1-项目概述)
2. [整体架构](#2-整体架构)
3. [目录结构](#3-目录结构)
4. [核心模块详解](#4-核心模块详解)
5. [数据库设计](#5-数据库设计)
6. [API 接口](#6-api-接口)
7. [关键设计机制](#7-关键设计机制)
8. [部署与运行](#8-部署与运行)
9. [配置说明](#9-配置说明)

---

## 1. 项目概述

### 1.1 项目简介

AI Gateway 是一个统一的 AI 提供商 API 代理网关，支持多 Key 轮询、健康检查、自动故障转移、Key 级限流配额、用量统计与 Prometheus 指标。项目完全 Docker 化，单容器即可运行。

### 1.2 核心功能

| 功能 | 说明 |
|------|------|
| **统一 API 接口** | 所有 AI 提供商通过 `/v1` 访问，兼容 OpenAI / Anthropic / Google 协议 |
| **多 Key 轮询** | 每个提供商可配置多个 API Key，请求随机打乱 |
| **健康检查** | 失败 Key 自动降权，连续失败 5 次后进入冷却 |
| **Key 自动恢复** | 降权 Key 冷却 5 分钟后自动获得一次试用机会 |
| **流式响应透传** | SSE 流式响应直接透传 ReadableStream，不缓冲 |
| **Key 级限流** | 每个 `sk_cf_*` 可独立配置 RPM、dailyQuota、allowedModels |
| **用量统计** | 每次转发记录状态码、耗时、token 消耗、错误信息 |
| **Prometheus 指标** | 内置 `/metrics` 端点，暴露多种监控指标 |
| **多提供商管理** | 内置 DeepSeek / OpenAI / Anthropic / Gemini，支持自定义 |
| **管理后台** | 卡片式 UI，移动端自适应，无需前端构建 |

### 1.3 技术栈

| 类别 | 技术 |
|------|------|
| 运行时 | Node.js 22+ |
| Web 框架 | [Hono](https://hono.dev/) v4 + `@hono/node-server` |
| 数据库 | SQLite ([better-sqlite3](https://github.com/WiseLibs/better-sqlite3))，WAL 模式 |
| 指标 | [prom-client](https://github.com/siimon/prom-client) |
| 语言 | TypeScript（严格模式） |
| 容器化 | Docker + Docker Compose |

---

## 2. 整体架构

### 2.1 架构分层

```
┌─────────────────────────────────────────────────┐
│                   客户端                         │
└─────────────────────┬───────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────┐
│                Hono Web 层                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐       │
│  │ 路由注册 │  │ CORS/日志│  │ 错误处理 │       │
│  └──────────┘  └──────────┘  └──────────┘       │
└─────────────────────┬───────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────┐
│               中间件层                           │
│  ┌──────────────┐   ┌──────────────┐            │
│  │ Session 认证 │   │ Proxy Key 认证│            │
│  │ (admin/*)    │   │ (/v1/*)      │            │
│  └──────────────┘   └──────┬───────┘            │
│                            │                    │
│                   ┌────────▼────────┐           │
│                   │ RPM/日配额限流  │           │
│                   └─────────────────┘           │
└─────────────────────┬───────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────┐
│               业务逻辑层                         │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐        │
│  │ 代理转发 │ │ 提供商管理│ │用量统计  │        │
│  │ (proxy)  │ │ (admin)  │ │          │        │
│  └──────────┘ └──────────┘ └──────────┘        │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐        │
│  │ Key健康  │ │ 页面渲染 │ │ 指标收集 │        │
│  └──────────┘ └──────────┘ └──────────┘        │
└─────────────────────┬───────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────┐
│               存储层 (storage.ts)                │
│  providers / proxy_keys / sessions / key_health  │
│  usage_logs / rate_counters                      │
└─────────────────────┬───────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────┐
│              SQLite 数据库 (db.ts)               │
│  WAL 模式 / 外键约束 / 幂等迁移                  │
└─────────────────────────────────────────────────┘
```

### 2.2 请求流程

#### API 转发请求流程

```
客户端请求 /v1/chat/completions
         │
         ▼
proxyKeyAuthMiddleware
  ├─ 验证 Authorization Bearer Token
  ├─ 查询 proxy_keys 表校验 Key 有效性
  └─ 原子递增 RPM + daily 窗口计数
         │
         ▼
handleProxy
  ├─ 解析 model 字段 → providerId + modelId
  ├─ 检查 allowedModels 白名单
  ├─ 查询提供商配置与启用状态
  ├─ 读取 Key 健康状态
  ├─ 按健康度排序 Key（健康→不健康→试用→降权）
  ├─ 依次尝试 Key 转发请求
  │   ├─ 成功 → 重置 Key 健康状态、记录用量、返回响应
  │   ├─ 429 限流 → 跳过当前 Key，不计失败
  │   ├─ 401/403/5xx → 标记失败，failures++，尝试下一个
  │   └─ 网络错误 → 标记失败，尝试下一个
  └─ 全部失败 → 返回 key_exhausted 错误
         │
         ▼
  同步写入 usage_logs + 更新 Prometheus 指标
```

#### 管理后台请求流程

```
浏览器访问 /admin
     │
     ▼
adminAuthMiddleware
  ├─ 读取 session_id Cookie
  ├─ 查询 sessions 表校验 Session
  └─ 过期则重定向到 /admin/login
     │
     ▼
renderAdminPage (服务端渲染 HTML)
     │
     ▼
前端 JS 通过 fetch 调用 /admin/api/* 接口
```

---

## 3. 目录结构

```
ai-gateway/
├── src/
│   ├── index.ts          # 入口：路由注册、服务启动、定期清理
│   ├── types.ts          # 类型定义（Env / Provider / ProxyKey / UsageLog 等）
│   ├── config.ts         # 默认配置常量 + 环境变量读取
│   ├── db.ts             # SQLite 初始化、schema 迁移、自愈逻辑
│   ├── storage.ts        # 存储层：所有数据库 CRUD 操作
│   ├── auth.ts           # 认证中间件：Session 认证 + Proxy Key 认证 + 限流
│   ├── proxy.ts          # 代理转发核心：Key 轮询、健康检查、流式透传
│   ├── admin.ts          # 管理 API：提供商 CRUD、Key 管理、用量统计
│   ├── metrics.ts        # Prometheus 指标定义与 /metrics 端点
│   ├── pages.ts          # 服务端渲染：首页、登录页、管理后台
│   ├── pages.css.ts      # 前端 CSS 样式
│   └── shared.js.ts      # 前端共享 JS 工具函数
├── Dockerfile            # 多阶段 Docker 构建
├── docker-compose.yml    # Docker Compose 配置
├── package.json          # 项目依赖与脚本
├── tsconfig.json         # TypeScript 配置
├── README.md             # 使用说明
├── API.md                # API 文档
└── LICENSE               # Apache 2.0 许可证
```

---

## 4. 核心模块详解

### 4.1 入口模块 — [index.ts](file:///workspace/src/index.ts)

**文件路径**: `src/index.ts`

**核心职责**:
- 初始化数据库连接
- 构建 Hono 应用并注册所有路由
- 启动 HTTP 服务器
- 设置定期清理任务

**主要函数**:

| 函数 | 说明 |
|------|------|
| `main()` | 应用入口函数，完成所有初始化工作 |

**路由注册**:

| 路径 | 方法 | 处理函数 | 认证 |
|------|------|----------|------|
| `/` | GET | `renderHomePage` | 无 |
| `/admin/login` | GET/POST | `renderLoginPage` / `handleLogin` | 无 |
| `/admin/logout` | GET | `handleLogout` | 无 |
| `/metrics` | GET | `handleMetrics` | 可选 Bearer Token |
| `/admin/*` | ALL | `adminAuthMiddleware` | Session |
| `/admin/api/status` | GET | `handleStatus` | Session |
| `/admin/api/providers` | GET/POST | `handleGetProviders` / `handleCreateProvider` | Session |
| `/admin/api/providers/:id` | PUT/DELETE | `handleUpdateProvider` / `handleDeleteProvider` | Session |
| `/admin/api/providers/:id/test-model` | POST | `handleTestModel` | Session |
| `/admin/api/test-key` | POST | `handleTestKeyNew` | Session |
| `/admin/api/test-model` | POST | `handleTestModelNew` | Session |
| `/admin/api/proxy-keys` | GET/POST | `handleGetProxyKeys` / `handleCreateProxyKey` | Session |
| `/admin/api/proxy-keys/:id` | PATCH/DELETE | `handleUpdateProxyKey` / `handleDeleteProxyKey` | Session |
| `/admin/api/usage/summary` | GET | `handleUsageSummary` | Session |
| `/admin/api/usage/logs` | GET | `handleUsageLogs` | Session |
| `/v1/*` | ALL | `proxyKeyAuthMiddleware` | Proxy Key |
| `/v1/models` | GET | `handleModels` | Proxy Key |
| `/v1/*` | ALL | `handleProxy` | Proxy Key |

**定期任务**:
- 每小时清理 2 天前的限流计数器
- 每小时清理超期用量日志（默认保留 90 天）

---

### 4.2 类型定义 — [types.ts](file:///workspace/src/types.ts)

**文件路径**: `src/types.ts`

**核心接口**:

#### Provider — 提供商配置

```typescript
interface Provider {
  id: string                    // 唯一标识
  name: string                  // 显示名称
  baseUrl: string               // API 基础地址
  apiType?: 'openai' | 'anthropic' | 'google'  // API 协议类型
  apiKeys: ApiKeyEntry[]        // API Key 列表
  models: Model[]               // 模型列表
  enabled: boolean              // 是否启用
  createdAt: string             // 创建时间
  updatedAt: string             // 更新时间
}
```

#### ProxyKey — 转发 Key

```typescript
interface ProxyKey {
  id: string                    // UUID
  key: string                   // 完整 Key (sk_cf_xxx)
  name: string                  // 名称
  enabled: boolean              // 是否启用
  createdAt: string             // 创建时间
  expiresAt?: string | null     // 过期时间
  rpm: number                   // 每分钟最大请求数（0=不限）
  dailyQuota: number            // 每日最大请求数（0=不限）
  allowedModels: string[]       // 允许的模型前缀白名单
}
```

#### UsageLog — 用量日志

```typescript
interface UsageLog {
  id: number                    // 自增 ID
  proxyKeyId: string            // 转发 Key ID
  proxyKeyName: string          // 转发 Key 名称
  providerId: string            // 提供商 ID
  model: string                 // 模型 ID（含提供商前缀）
  status: number                // HTTP 状态码
  durationMs: number            // 耗时（毫秒）
  promptTokens: number          // prompt token 数
  completionTokens: number      // completion token 数
  totalTokens: number           // 总 token 数
  stream: number                // 是否流式（0/1）
  error: string | null          // 错误信息
  createdAt: string             // 创建时间
}
```

#### Env — 运行时环境

```typescript
interface Env {
  db: DB                        // SQLite 数据库实例
  ADMIN_USERNAME?: string       // 管理员用户名
  ADMIN_PASSWORD?: string       // 管理员密码
}
```

---

### 4.3 配置模块 — [config.ts](file:///workspace/src/config.ts)

**文件路径**: `src/config.ts`

**核心常量**:

| 常量 | 默认值 | 说明 |
|------|--------|------|
| `SITE_CONFIG` | — | 站点配置（标题、作者、CDN 等） |
| `SESSION_TTL` | 7 天 | 管理后台 Session 有效期（秒） |
| `PROXY_KEY_PREFIX` | `sk_cf_` | 转发 Key 前缀 |
| `KEY_HEALTH_COOLDOWN_MS` | 5 分钟 | Key 降权后冷却时间（毫秒） |
| `KEY_HEALTH_MAX_FAILURES` | 5 | 连续失败次数阈值，达到后降权 |
| `UPSTREAM_TIMEOUT_MS` | 60 秒 | 上游请求超时时间（毫秒） |
| `RPM_WINDOW_MS` | 60 秒 | RPM 限流窗口大小（毫秒） |
| `DB_PATH` | `./data/ai-gateway.db` | 数据库文件路径 |
| `PORT` | `8787` | HTTP 监听端口 |
| `USAGE_LOG_RETENTION_DAYS` | `90` | 用量日志保留天数 |

**默认提供商**:
- DeepSeek (openai 协议)
- OpenAI (openai 协议)
- Anthropic (anthropic 协议)
- Gemini (google 协议)

---

### 4.4 数据库模块 — [db.ts](file:///workspace/src/db.ts)

**文件路径**: `src/db.ts`

**核心函数**:

| 函数 | 说明 |
|------|------|
| `openDatabase(dbPath)` | 打开并初始化 SQLite 数据库 |
| `applyMigrations(db)` | 应用 schema 迁移（幂等） |
| `healProviderConfig(db)` | 自愈已知错误配置 |

**数据库特性**:
- **WAL 模式**: 提升并发读性能
- **外键约束**: 启用 `foreign_keys = ON`
- **忙超时**: `busy_timeout = 5000` 毫秒
- **幂等迁移**: 所有 CREATE 语句使用 `IF NOT EXISTS`

**自愈逻辑**:
- 自动修正 Gemini 的 base_url 从 `/v1` 到 `/v1beta`

---

### 4.5 存储层 — [storage.ts](file:///workspace/src/storage.ts)

**文件路径**: `src/storage.ts`

**核心职责**: 封装所有数据库 CRUD 操作，提供类型安全的数据访问接口。

#### 提供商 CRUD

| 函数 | 说明 |
|------|------|
| `getProviders(env)` | 获取所有提供商 |
| `getProvider(env, id)` | 获取单个提供商 |
| `addProvider(env, provider)` | 添加提供商 |
| `updateProvider(env, id, updates)` | 更新提供商 |
| `deleteProvider(env, id)` | 删除提供商（同时清理 key_health） |

#### Session 管理

| 函数 | 说明 |
|------|------|
| `createSession(env, username, ttlSeconds)` | 创建 Session，返回 sessionId |
| `getSession(env, sessionId)` | 获取 Session（过期自动删除并返回 null） |
| `deleteSession(env, sessionId)` | 删除 Session |

#### 转发 Key 管理

| 函数 | 说明 |
|------|------|
| `getProxyKeys(env)` | 获取所有转发 Key |
| `addProxyKey(env, key)` | 添加转发 Key |
| `updateProxyKey(env, id, updates)` | 更新转发 Key |
| `deleteProxyKey(env, id)` | 删除转发 Key |
| `validateProxyKey(env, key)` | 校验 Key 有效性（启用、未过期） |

#### Key 健康状态

| 函数 | 说明 |
|------|------|
| `readHealth(env, providerId)` | 读取提供商下所有 Key 的健康状态 |
| `writeHealth(env, providerId, health)` | 覆盖式写入健康状态 |
| `upsertKeyHealth(env, providerId, apiKey, health)` | 更新单个 Key 的健康记录 |
| `deleteKeyHealth(env, providerId, apiKey)` | 删除单个 Key 的健康记录 |

#### 限流计数器

| 函数 | 说明 |
|------|------|
| `incrementRateCounter(env, keyId, rpmWindowStart, dailyWindowStart)` | 原子递增 RPM + daily 窗口计数 |
| `purgeRateCounters(env, olderThanMs)` | 清理过期限流计数器 |

#### 用量日志

| 函数 | 说明 |
|------|------|
| `insertUsageLog(env, input)` | 插入用量日志 |
| `queryUsageLogs(env, opts)` | 查询用量日志明细 |
| `getUsageSummaryByProxyKey(env, fromIso, toIso)` | 按 Key 聚合用量统计 |
| `getUsageSummaryByProvider(env, fromIso, toIso)` | 按提供商聚合用量统计 |
| `purgeUsageLogs(env, olderThanIso)` | 清理超期用量日志 |

#### 初始化

| 函数 | 说明 |
|------|------|
| `seedInitialData(env)` | 首次启动填充默认提供商 + 测试 Key |

---

### 4.6 认证模块 — [auth.ts](file:///workspace/src/auth.ts)

**文件路径**: `src/auth.ts`

**核心职责**: 管理后台 Session 认证、API 转发 Key 认证、RPM/日配额限流。

#### 管理后台 Session 认证

**中间件**: `adminAuthMiddleware`

- 读取 `session_id` Cookie
- 查询 `sessions` 表校验有效性
- API 请求未登录返回 401 JSON
- 页面请求未登录重定向到 `/admin/login`
- Session 过期自动清理

**登录处理**: `handleLogin`
- 用户名明文比对
- 密码 SHA-256 哈希比对
- 登录成功创建 Session 并设置 Cookie
- Cookie 属性：HttpOnly、Secure（根据协议自动判断）、SameSite=Lax、7 天有效期

**退出处理**: `handleLogout`
- 删除 Session 记录
- 清除 Cookie
- 重定向到首页

#### Proxy Key 认证 + 限流

**中间件**: `proxyKeyAuthMiddleware`

执行流程:
1. 验证 `Authorization: Bearer sk_cf_*` 头
2. 查询 `proxy_keys` 表校验 Key 有效性（启用、未过期）
3. **原子递增** RPM 窗口 + daily 窗口计数（事务保证无竞态）
4. 检查 RPM 超限 → 返回 429 `rate_limit_error`
5. 检查 dailyQuota 超限 → 返回 429 `quota_exceeded`
6. 将 `ProxyKeyContext` 挂到 `c.var.proxyKey` 供下游使用

#### 工具函数

| 函数 | 说明 |
|------|------|
| `hashPassword(password)` | SHA-256 哈希密码 |
| `isModelAllowed(ctx, fullModelId)` | 检查模型是否在 allowedModels 白名单内 |

**白名单匹配规则**:
- 空数组 → 全部允许
- 完整匹配：`openai/gpt-4o`
- 前缀匹配：`openai/` 匹配所有 `openai/*` 模型

---

### 4.7 代理转发模块 — [proxy.ts](file:///workspace/src/proxy.ts)

**文件路径**: `src/proxy.ts`

**核心职责**: API 请求转发、Key 健康检查、故障转移、流式透传、用量记录。

#### 核心函数

| 函数 | 说明 |
|------|------|
| `handleProxy(c)` | 处理所有 `/v1/*` 转发请求 |
| `handleModels(c)` | 处理 `/v1/models` 返回可用模型列表 |
| `testModelConnection(baseUrl, apiKey, modelId, apiType)` | 测试模型连接 |
| `parseModelId(model)` | 解析 `提供商ID/模型ID` 格式 |
| `extractUsage(body, apiType)` | 从响应体提取 token 用量 |
| `buildUpstreamHeaders(provider, apiKey)` | 构建上游请求头 |

#### Key 健康排序算法

```
Key 分组（按健康度从高到低）：
┌───────────────────────────────────────────────┐
│ 1. healthy  (failures = 0)  → Fisher-Yates 洗牌 │
│ 2. unhealthy (0 < failures < MAX)             │
│ 3. probation (冷却到期的降权 Key，限试一次)    │
│ 4. demoted   (failures >= MAX 且在冷却中)     │
└───────────────────────────────────────────────┘

特殊规则：
- 仅有 1 个 Key 时跳过所有健康检查
- 所有 Key 都降权时，回退使用全部降权 Key
```

#### 失败处理规则

| 错误类型 | 处理方式 |
|----------|----------|
| `2xx 成功` | 重置该 Key 健康状态（failures 归零） |
| `429 限流` | 跳过当前 Key，**不计入失败次数** |
| `401/403/5xx` | failures++，连续达 5 次降权，尝试下一个 Key |
| 网络错误 | failures++，连续达 5 次降权，尝试下一个 Key |
| `400/404 等` | 直接返回错误，不算 Key 失败 |

#### 协议适配

**OpenAI 兼容** (apiType: 'openai'):
- 鉴权头：`Authorization: Bearer <key>`
- 端点：原样转发 `/v1/*` → `baseUrl/*`

**Anthropic 兼容** (apiType: 'anthropic'):
- 鉴权头：`x-api-key: <key>` + `anthropic-version: 2023-06-01`
- 端点：原样转发

**Google Gemini** (apiType: 'google'):
- 鉴权头：`x-goog-api-key: <key>`
- 请求转换：OpenAI 格式 → Gemini 格式（messages、generationConfig）
- 响应转换：Gemini 格式 → OpenAI 兼容格式
- 流式转换：Gemini SSE → OpenAI SSE
- 端点转换：`/v1/chat/completions` → `models/{model}:generateContent` 或 `streamGenerateContent`

#### 流式响应处理

- 检测 `stream: true` 或 `Content-Type: text/event-stream`
- 直接透传 `ReadableStream`，不缓冲
- 设置响应头：
  - `Cache-Control: no-cache, no-transform`
  - `X-Accel-Buffering: no`
  - `Connection: keep-alive`
- 流式请求不计 token 用量（记为 0）

---

### 4.8 管理 API 模块 — [admin.ts](file:///workspace/src/admin.ts)

**文件路径**: `src/admin.ts`

**核心职责**: 管理后台所有 API 接口。

#### 系统状态

| 端点 | 函数 | 说明 |
|------|------|------|
| `GET /admin/api/status` | `handleStatus` | 获取系统状态总览 |

#### 提供商 CRUD

| 端点 | 函数 | 说明 |
|------|------|------|
| `GET /admin/api/providers` | `handleGetProviders` | 获取所有提供商列表 |
| `POST /admin/api/providers` | `handleCreateProvider` | 添加新提供商 |
| `PUT /admin/api/providers/:id` | `handleUpdateProvider` | 更新提供商配置 |
| `DELETE /admin/api/providers/:id` | `handleDeleteProvider` | 删除提供商 |
| `POST /admin/api/providers/:id/test-model` | `handleTestModel` | 测试指定模型连接 |

#### 连通性测试

| 端点 | 函数 | 说明 |
|------|------|------|
| `POST /admin/api/test-key` | `handleTestKeyNew` | 测试 API Key 是否有效（通过服务端代理避免 CORS） |
| `POST /admin/api/test-model` | `handleTestModelNew` | 测试模型连接（通过服务端代理） |

#### 转发 Key 管理

| 端点 | 函数 | 说明 |
|------|------|------|
| `GET /admin/api/proxy-keys` | `handleGetProxyKeys` | 获取所有转发 Key（脱敏显示） |
| `POST /admin/api/proxy-keys` | `handleCreateProxyKey` | 生成新的转发 Key（仅返回一次明文） |
| `PATCH /admin/api/proxy-keys/:id` | `handleUpdateProxyKey` | 更新 Key 配置（名称、启用状态、限流等） |
| `DELETE /admin/api/proxy-keys/:id` | `handleDeleteProxyKey` | 删除转发 Key |

**Key 格式**: `sk_cf_` + 32 位随机 hex（UUID 去除连字符）

#### 用量统计

| 端点 | 函数 | 说明 |
|------|------|------|
| `GET /admin/api/usage/summary` | `handleUsageSummary` | 获取用量汇总（支持时间范围过滤） |
| `GET /admin/api/usage/logs` | `handleUsageLogs` | 获取用量日志明细（分页 + 过滤） |

---

### 4.9 指标模块 — [metrics.ts](file:///workspace/src/metrics.ts)

**文件路径**: `src/metrics.ts`

**核心职责**: Prometheus 指标定义、数据上报、`/metrics` 端点。

#### 自定义指标

| 指标名 | 类型 | 标签 | 说明 |
|--------|------|------|------|
| `ai_gateway_requests_total` | Counter | `provider`, `status`, `stream` | 转发请求总数 |
| `ai_gateway_tokens_total` | Counter | `provider`, `type` | 消耗 token 总数（type=prompt/completion） |
| `ai_gateway_request_duration_ms` | Histogram | `provider` | 转发请求耗时（毫秒） |
| `ai_gateway_key_failures_total` | Counter | `provider` | 上游 API Key 失败次数 |
| `ai_gateway_rate_limit_hits_total` | Counter | `type` | 命中限流次数（type=rpm/daily） |

#### 默认指标

- `ai_gateway_node_*`: Node.js 进程指标（CPU / 内存 / GC / 事件循环等）

#### 上报函数

| 函数 | 说明 |
|------|------|
| `recordProxyOutcome(o)` | 记录一次转发请求的结果 |
| `recordTokens(providerId, promptTokens, completionTokens)` | 记录 token 消耗 |
| `recordRateLimitHit(type)` | 记录一次限流命中 |

#### /metrics 端点

- 路径：`GET /metrics`
- 格式：Prometheus 文本格式
- 鉴权：可选 Bearer Token（`METRICS_TOKEN` 环境变量）

---

### 4.10 页面渲染模块 — [pages.ts](file:///workspace/src/pages.ts)

**文件路径**: `src/pages.ts`

**核心职责**: 服务端渲染 HTML 页面（无前端构建）。

#### 页面列表

| 页面 | 函数 | 路径 | 认证 |
|------|------|------|------|
| 首页 | `renderHomePage` | `/` | 可选 |
| 登录页 | `renderLoginPage` | `/admin/login` | 无 |
| 管理后台 | `renderAdminPage` | `/admin` | Session |

#### 页面特性

- **服务端渲染**: 数据在服务端注入到 HTML 模板
- **零前端构建**: CSS 内联在 `<style>` 标签，JS 内联在 `<script>` 标签
- **响应式设计**: 移动端自适应布局
- **卡片式 UI**: 提供商列表、Key 列表、用量统计均为卡片布局

#### 前端交互（管理后台）

- 提供商展开/折叠、增删改
- API Key 增删、连通性测试
- 模型增删、连通性测试
- 转发 Key 生成、启用/禁用、删除
- 用量统计：按 Key 聚合 / 按 Provider 聚合 / 明细日志
- 全部通过 `fetch` 调用 `/admin/api/*` 接口

---

## 5. 数据库设计

### 5.1 表结构总览

| 表名 | 用途 |
|------|------|
| `providers` | 提供商配置 |
| `sessions` | 管理后台 Session |
| `proxy_keys` | 转发 Key |
| `key_health` | 上游 API Key 健康状态 |
| `usage_logs` | 用量日志 |
| `rate_counters` | 限流计数器 |

### 5.2 providers 表

```sql
CREATE TABLE providers (
  id          TEXT PRIMARY KEY,           -- 提供商唯一 ID
  name        TEXT NOT NULL,              -- 显示名称
  base_url    TEXT NOT NULL,              -- API 基础地址
  api_type    TEXT NOT NULL DEFAULT 'openai',  -- API 协议类型
  api_keys    TEXT NOT NULL DEFAULT '[]', -- JSON 数组: [{key, enabled}]
  models      TEXT NOT NULL DEFAULT '[]', -- JSON 数组: [{id, enabled}]
  enabled     INTEGER NOT NULL DEFAULT 1, -- 是否启用
  created_at  TEXT NOT NULL,              -- 创建时间 ISO 8601
  updated_at  TEXT NOT NULL               -- 更新时间 ISO 8601
);
```

### 5.3 sessions 表

```sql
CREATE TABLE sessions (
  session_id  TEXT PRIMARY KEY,           -- Session ID (UUID)
  username    TEXT NOT NULL,              -- 用户名
  expires_at  INTEGER NOT NULL,           -- 过期时间戳（毫秒）
  created_at  TEXT NOT NULL               -- 创建时间
);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
```

### 5.4 proxy_keys 表

```sql
CREATE TABLE proxy_keys (
  id              TEXT PRIMARY KEY,       -- Key ID (UUID)
  key             TEXT NOT NULL UNIQUE,   -- 完整 Key (sk_cf_xxx)
  name            TEXT NOT NULL,          -- 名称
  enabled         INTEGER NOT NULL DEFAULT 1,  -- 是否启用
  created_at      TEXT NOT NULL,          -- 创建时间
  expires_at      TEXT,                   -- 过期时间（null=永久）
  rpm             INTEGER NOT NULL DEFAULT 0,  -- 每分钟请求限制（0=不限）
  daily_quota     INTEGER NOT NULL DEFAULT 0,  -- 每日请求配额（0=不限）
  allowed_models  TEXT NOT NULL DEFAULT '[]'  -- JSON 数组: 模型前缀白名单
);
```

### 5.5 key_health 表

```sql
CREATE TABLE key_health (
  provider_id   TEXT NOT NULL,            -- 提供商 ID
  api_key       TEXT NOT NULL,            -- 上游 API Key
  failures      INTEGER NOT NULL DEFAULT 0,  -- 连续失败次数
  last_failed   INTEGER NOT NULL DEFAULT 0,  -- 上次是否失败（0/1）
  demoted_at    INTEGER,                  -- 降权时间戳（毫秒）
  PRIMARY KEY (provider_id, api_key)
);
```

### 5.6 usage_logs 表

```sql
CREATE TABLE usage_logs (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  proxy_key_id        TEXT NOT NULL,      -- 转发 Key ID
  proxy_key_name      TEXT NOT NULL,      -- 转发 Key 名称（冗余，便于展示）
  provider_id         TEXT NOT NULL,      -- 提供商 ID
  model               TEXT NOT NULL,      -- 模型 ID（含提供商前缀）
  status              INTEGER NOT NULL,   -- HTTP 状态码
  duration_ms         INTEGER NOT NULL DEFAULT 0,  -- 耗时（毫秒）
  prompt_tokens       INTEGER NOT NULL DEFAULT 0,  -- prompt token
  completion_tokens   INTEGER NOT NULL DEFAULT 0,  -- completion token
  total_tokens        INTEGER NOT NULL DEFAULT 0,  -- 总 token
  stream              INTEGER NOT NULL DEFAULT 0,  -- 是否流式（0/1）
  error               TEXT,               -- 错误信息
  created_at          TEXT NOT NULL       -- 创建时间
);
CREATE INDEX idx_usage_created   ON usage_logs(created_at);
CREATE INDEX idx_usage_key       ON usage_logs(proxy_key_id, created_at);
CREATE INDEX idx_usage_provider  ON usage_logs(provider_id, created_at);
```

### 5.7 rate_counters 表

```sql
CREATE TABLE rate_counters (
  key_id        TEXT NOT NULL,            -- 转发 Key ID
  window_start  INTEGER NOT NULL,         -- 窗口起始时间戳（毫秒）
  count         INTEGER NOT NULL DEFAULT 0,  -- 请求计数
  PRIMARY KEY (key_id, window_start)
);
```

**窗口类型**:
- RPM 窗口：每 60 秒一个窗口（`window_start` 为分钟起始时间戳）
- Daily 窗口：每 24 小时一个窗口（UTC 当天 0 点）

---

## 6. API 接口

### 6.1 认证方式

| 认证方式 | 适用范围 | 格式 |
|----------|----------|------|
| Session Cookie | 管理后台页面 + `/admin/api/*` | `Cookie: session_id=<uuid>` |
| Bearer Token | `/v1/*` API 转发 | `Authorization: Bearer sk_cf_*` |
| Bearer Token（可选） | `/metrics` | `Authorization: Bearer <METRICS_TOKEN>` |

### 6.2 公开端点

#### GET /
首页，返回站点信息与已启用模型列表。

#### GET /metrics
Prometheus 指标端点（可选 Bearer Token 保护）。

### 6.3 API 转发端点（需 Proxy Key）

#### GET /v1/models
返回所有已启用的模型列表（OpenAI 兼容格式）。

**响应示例**:
```json
{
  "object": "list",
  "data": [
    {
      "id": "deepseek/deepseek-chat",
      "provider": "deepseek",
      "provider_name": "DeepSeek",
      "object": "model",
      "created": 1712345678,
      "owned_by": "deepseek"
    }
  ]
}
```

#### POST /v1/chat/completions
转发 OpenAI 兼容的聊天补全请求（支持流式）。

模型格式：`提供商ID/模型ID`，如 `deepseek/deepseek-chat`

#### POST /v1/messages
转发 Anthropic 兼容的 Messages 请求。

模型格式：`anthropic/模型ID`，如 `anthropic/claude-sonnet-4-20250514`

#### ALL /v1/*
其他子路径原样透传到对应提供商。

### 6.4 管理 API 端点（需 Session）

详见 [API.md](file:///workspace/API.md) 完整文档。

---

## 7. 关键设计机制

### 7.1 Key 健康检查与故障转移

**设计目标**: 在多 Key 场景下自动规避故障 Key，保证高可用。

**状态流转**:
```
健康 (failures=0)
  │
  │ 401/403/5xx / 网络错误
  ▼
失败 (0 < failures < 5)
  │
  │ 连续失败达 5 次
  ▼
降权 (failures >= 5, demotedAt 记录)
  │
  │ 冷却 5 分钟
  ▼
试用 (冷却到期，限试一次)
  │
  ├─ 成功 → 健康 (重置 failures=0)
  └─ 失败 → 降权 (重新冷却)
```

### 7.2 原子限流计数

**问题**: 并发请求下限流计数可能出现竞态。

**解决方案**: 使用 SQLite 事务 + `ON CONFLICT ... DO UPDATE` 保证原子性。

```typescript
// incrementRateCounter 内部使用事务
const tx = env.db.transaction(() => {
  // RPM 窗口原子递增
  env.db.prepare(`
    INSERT INTO rate_counters (key_id, window_start, count) VALUES (?, ?, 1)
    ON CONFLICT(key_id, window_start) DO UPDATE SET count = count + 1
  `).run(keyId, rpmWindowStart)
  // daily 窗口原子递增
  env.db.prepare(`
    INSERT INTO rate_counters (key_id, window_start, count) VALUES (?, ?, 1)
    ON CONFLICT(key_id, window_start) DO UPDATE SET count = count + 1
  `).run(keyId, dailyWindowStart)
  // 读取递增后的值
  const rpmRow = env.db.prepare('...').get(...)
  const dailyRow = env.db.prepare('...').get(...)
  return { rpmCount: rpmRow.count, dailyCount: dailyRow.count }
})
```

### 7.3 流式响应透传

**设计目标**: 流式响应低延迟、不缓冲。

**实现方式**:
- 检测到 `stream: true` 或 `Content-Type: text/event-stream`
- 直接返回上游的 `ReadableStream`
- 设置 `X-Accel-Buffering: no` 避免 Nginx 缓冲
- 设置 `Cache-Control: no-cache, no-transform`

### 7.4 服务端渲染（零构建）

**设计目标**: 管理后台无需前端构建，单容器部署。

**实现方式**:
- HTML 模板字符串直接渲染
- CSS 内联在 `<style>` 标签（[pages.css.ts](file:///workspace/src/pages.css.ts)）
- JS 内联在 `<script>` 标签（[shared.js.ts](file:///workspace/src/shared.js.ts) + 页面内联）
- 数据在服务端注入，后续交互通过 fetch API

---

## 8. 部署与运行

### 8.1 Docker 部署（推荐）

#### 环境要求
- Docker 20+
- Docker Compose v2+

#### 部署步骤

```bash
# 1. 克隆仓库
git clone <仓库地址>
cd ai-gateway

# 2. 修改 docker-compose.yml 中的管理员账号密码
#    ADMIN_USERNAME / ADMIN_PASSWORD

# 3. 启动服务
docker compose up -d --build
```

#### 访问地址

| 服务 | 地址 |
|------|------|
| 首页 | http://localhost:8787/ |
| 管理后台 | http://localhost:8787/admin/login |
| API 基址 | http://localhost:8787/v1 |
| Prometheus 指标 | http://localhost:8787/metrics |

#### 数据持久化

数据存储在 Docker 卷 `ai-gateway-data`，容器升级不丢数据。

### 8.2 本地开发

```bash
# 1. 安装依赖
npm install

# 2. 创建 .env 文件
cat > .env <<EOF
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your-password
PORT=8787
DB_PATH=./data/ai-gateway.db
EOF

# 3. 启动开发服务器（热重载）
npm run dev

# 4. 或编译后启动
npm run build
npm start
```

### 8.3 NPM 脚本

| 命令 | 说明 |
|------|------|
| `npm run dev` | 启动开发服务器（tsx watch，热重载） |
| `npm run build` | 编译 TypeScript 到 dist/ |
| `npm start` | 启动编译后的服务 |
| `npm run typecheck` | TypeScript 类型检查（不生成文件） |

### 8.4 Docker 构建说明

[Dockerfile](file:///workspace/Dockerfile) 使用多阶段构建：

**Builder 阶段**:
- 基础镜像：`node:22-bookworm-slim`
- 安装构建工具链（python3/make/g++，用于 better-sqlite3 原生模块）
- 安装全部依赖（含 devDependencies）
- 编译 TypeScript
- 重新安装生产依赖（重建原生模块）

**Runner 阶段**:
- 基础镜像：`node:22-bookworm-slim`
- 仅复制 dist/ + node_modules/ + package.json
- 数据卷：`/app/data`
- 健康检查：每 30 秒检查 `/admin/api/status`

---

## 9. 配置说明

### 9.1 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ADMIN_USERNAME` | — | 管理后台用户名（**必填**） |
| `ADMIN_PASSWORD` | — | 管理后台密码（**必填**） |
| `PORT` | `8787` | HTTP 监听端口 |
| `DB_PATH` | `/app/data/ai-gateway.db` | SQLite 数据库文件路径 |
| `USAGE_LOG_RETENTION_DAYS` | `90` | 用量日志保留天数 |
| `METRICS_TOKEN` | — | 保护 `/metrics` 的 Bearer Token（可选） |
| `NODE_ENV` | — | 设为 `production` 时启用 Cookie secure 标记 |

### 9.2 默认提供商配置

首次启动自动预置以下提供商（空 Key，需自行配置）：

| 提供商 | ID | API 类型 | 默认模型 |
|--------|----|----------|----------|
| DeepSeek | `deepseek` | openai | deepseek-chat, deepseek-reasoner |
| OpenAI | `openai` | openai | gpt-4o, gpt-4o-mini, gpt-4.1, o4-mini |
| Anthropic | `anthropic` | anthropic | claude-opus-4, claude-sonnet-4, claude-3-5-haiku |
| Gemini | `gemini` | google | gemini-3.5-flash, gemini-3-flash, 等 |

---

## 附录

### 错误类型速查

| 错误类型 | HTTP 状态码 | 说明 |
|----------|-------------|------|
| `authentication_error` | 401 | 认证失败 |
| `invalid_request_error` | 400/404 | 请求参数错误 |
| `provider_disabled` | 403 | 提供商已禁用 |
| `model_disabled` | 403 | 模型已禁用 |
| `model_forbidden` | 403 | API Key 不允许访问该模型 |
| `rate_limit_error` | 429 | 命中 RPM 限流 |
| `quota_exceeded` | 429 | 命中日配额限流 |
| `configuration_error` | 500 | 配置错误（如无可用 Key） |
| `key_exhausted` | 502/5xx | 所有 API Key 均失败 |
| `proxy_error` | 502 | 转发过程网络错误 |
| `server_error` | 500 | 服务器内部错误 |
| `not_found` | 404 | 接口不存在 |

### License

Apache 2.0
