# AI Gateway API 文档

## Base URL

```
https://你的域名
```

## 认证方式

### 管理后台认证 (Session Cookie)

登录成功后通过 `Set-Cookie` 写入 `session_id`（HttpOnly、Secure、SameSite=Lax，有效期 7 天）。后续所有 `/admin/*` 请求需携带该 Cookie。

| 端点 | 方法 | 说明 |
|------|------|------|
| `/admin/login` | GET | 登录页面 |
| `/admin/login` | POST | 登录提交 |
| `/admin/logout` | GET | 退出登录 |

#### POST /admin/login

提交 JSON 进行登录校验（用户名明文比对，密码 SHA-256 哈希比对）。账号密码通过环境变量 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 配置。

**请求体**:
```json
{
  "username": "admin",
  "password": "your_password"
}
```

**成功响应** (`200`):
```json
{
  "success": true,
  "message": "登录成功"
}
```

**失败响应**:

| 状态码 | 场景 | 响应 |
|--------|------|------|
| 400 | 用户名/密码为空 | `{ "success": false, "message": "请输入用户名和密码" }` |
| 401 | 用户名或密码错误 | `{ "success": false, "message": "用户名或密码错误" }` |
| 500 | 未配置管理员账号 | `{ "success": false, "message": "未配置管理员账号，请在 Cloudflare 环境变量中设置 ADMIN_USERNAME 和 ADMIN_PASSWORD" }` |

#### GET /admin/logout

删除当前 Session 并清除 Cookie，重定向到首页 (`/`)。

---

### API 转发认证 (Bearer Token)

所有 `/v1/*` 请求需在 Header 中携带转发 API Key（即管理后台生成的 `sk_cf_*`）：

```
Authorization: Bearer sk_cf_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

**失败响应** (`401`):
```json
{
  "error": { "message": "缺少或无效的 Authorization 头，格式: Bearer sk_cf_*", "type": "authentication_error" }
}
```
或
```json
{
  "error": { "message": "API Key 无效或已禁用", "type": "authentication_error" }
}
```

## API 端点

### 公开端点

#### GET /

首页，返回站点信息与所有已启用提供商/模型列表（无需认证）。

---

### API 转发端点（需 Bearer Token）

#### GET /v1/models

返回所有已启用的模型列表（提供商与模型均需处于启用状态）。

**响应**:
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

---

#### POST /v1/chat/completions

转发 OpenAI 兼容的聊天补全请求。

**请求体**:
```json
{
  "model": "deepseek/deepseek-chat",
  "messages": [{"role": "user", "content": "Hello!"}]
}
```

模型格式: `提供商ID/模型ID`

**响应**: 透传 AI 提供商的原始响应（含流式响应）。

---

#### POST /v1/messages

转发 Anthropic 兼容的 Messages 请求。需将模型指定为 `anthropic/<模型ID>`。

**请求体**:
```json
{
  "model": "anthropic/claude-sonnet-4-20250514",
  "messages": [{"role": "user", "content": "Hello!"}],
  "max_tokens": 1024
}
```

**响应**: 透传 Anthropic 的原始响应。

---

#### ALL /v1/*

其他 `/v1/*` 子路径请求会原样透传到对应提供商。转发逻辑：

1. 解析 `model` 字段中的 `提供商ID/模型ID`，定位提供商与模型配置
2. 校验提供商/模型是否启用、是否配置了可用 API Key
3. 将请求体中的 `model` 改写为纯 `模型ID`，路径去除 `/v1/` 前缀拼接到提供商 `baseUrl`
4. **Key 排序与健康检查**：
   - 读取该提供商下每个 Key 的历史健康状态（持久化在 SQLite `key_health` 表）
   - **健康 Key**（无失败记录）：Fisher-Yates 洗牌后优先使用
   - **不健康 Key**（有失败记录，< 5 次）：追加到队列末尾
   - **降权 Key**（连续失败 >= 5 次）：进入冷却排除，**5 分钟后自动恢复试用**
   - **试用 Key**（冷却到期）：追加到不健康 Key 之后，限试一次
   - 仅有 1 个 Key 时跳过所有健康检查
5. 按排序后的顺序依次尝试；遇 `401/403/5xx` 或网络错误时标记该 Key 失败（`failures++`、`demotedAt` 刷新）并切换下一个；`429` 跳过但不计失败；成功时重置该 Key 的健康状态。每次请求（含成功/失败/配置错误）都会写入 `usage_logs` 表

**Key 健康状态**存储在 SQLite `key_health` 表中，每次请求后更新，仅保留有失败记录的 Key。

> **流式响应**：请求体含 `stream: true` 或上游返回 `text/event-stream` 时，网关直接透传 ReadableStream，不缓冲，并设置 `Cache-Control: no-cache, no-transform` / `X-Accel-Buffering: no`。流式请求不解析 token 用量（记为 0），非流式请求从响应体的 `usage` 字段提取 prompt / completion / total tokens。

> Anthropic 协议的提供商请求会使用 `x-api-key` + `anthropic-version: 2023-06-01` 头；OpenAI 协议使用 `Authorization: Bearer <key>` 头。请求超时为 60 秒。

---

### 管理 API 端点（需 Session 认证）

所有 `/admin/api/*` 端点需先登录并携带 Session Cookie，未登录返回 `401`：
```json
{ "success": false, "message": "未登录" }
```
Session 过期返回 `401`：
```json
{ "success": false, "message": "Session 已过期" }
```

#### GET /admin/api/status

获取系统状态总览。

**响应**:
```json
{
  "success": true,
  "data": {
    "providersCount": 4,
    "enabledProvidersCount": 4,
    "modelsCount": 12,
    "enabledModelsCount": 12,
    "proxyKeysCount": 2,
    "adminConfigured": true,
    "baseUrl": "https://your-domain.com"
  }
}
```

| 字段 | 说明 |
|------|------|
| `providersCount` | 提供商总数 |
| `enabledProvidersCount` | 已启用提供商数 |
| `modelsCount` | 模型总数 |
| `enabledModelsCount` | 已启用模型数 |
| `proxyKeysCount` | 已启用的转发 Key 数 |
| `adminConfigured` | 是否已配置 `ADMIN_USERNAME` / `ADMIN_PASSWORD` |
| `baseUrl` | 当前部署的根域名 |

---

#### GET /admin/api/providers

获取所有提供商列表（含完整 API Key）。

**响应**:
```json
{
  "success": true,
  "data": [
    {
      "id": "deepseek",
      "name": "DeepSeek",
      "baseUrl": "https://api.deepseek.com",
      "apiType": "openai",
      "apiKeys": [
        { "key": "sk-xxx1", "enabled": true },
        { "key": "sk-xxx2", "enabled": false }
      ],
      "models": [
        { "id": "deepseek-chat", "enabled": true },
        { "id": "deepseek-reasoner", "enabled": false }
      ],
      "enabled": true,
      "createdAt": "2024-01-01T00:00:00.000Z",
      "updatedAt": "2024-01-01T00:00:00.000Z"
    }
  ]
}
```

---

#### POST /admin/api/providers

添加新提供商。

**请求体**:
```json
{
  "id": "my-provider",
  "name": "我的提供商",
  "baseUrl": "https://api.example.com",
  "apiType": "openai",
  "apiKeys": ["sk-xxx"],
  "models": ["model-1", "model-2"],
  "enabled": true
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | ✅ | 提供商唯一标识，需全局唯一 |
| `name` | ✅ | 显示名称 |
| `baseUrl` | ✅ | 提供商 API 基础地址，尾部 `/` 会被自动去除 |
| `apiType` | ❌ | `openai`（默认）或 `anthropic` |
| `apiKeys` | ❌ | 字符串数组或 `{key, enabled}` 对象数组 |
| `models` | ❌ | 字符串数组或 `{id, enabled}` 对象数组 |
| `enabled` | ❌ | 默认 `true` |

**成功响应** (`201`): 返回新建的 Provider 对象。

**冲突响应** (`409`): `提供商 id "my-provider" 已存在`。

---

#### PUT /admin/api/providers/:id

更新提供商配置。`id`、`baseUrl`、`apiType` 等字段均可更新，`updatedAt` 自动刷新。

**请求体**（所有字段可选）:
```json
{
  "name": "新名称",
  "baseUrl": "https://new-api.example.com",
  "apiType": "anthropic",
  "apiKeys": [{"key": "sk-new-key", "enabled": true}],
  "models": [{"id": "new-model", "enabled": true}],
  "enabled": false
}
```

> `apiKeys` / `models` 传数组时为**整体替换**，支持字符串数组或 `{key/id, enabled}` 对象数组。

**成功响应**: 返回更新后的 Provider 对象。

**未找到** (`404`): `提供商不存在`。

---

#### DELETE /admin/api/providers/:id

删除提供商。

**成功响应**:
```json
{ "success": true, "message": "提供商已删除" }
```

---

#### POST /admin/api/providers/:id/test-model

测试指定提供商下某个模型的连接是否可用。发送最小请求（`max_tokens: 1`，超时 15 秒）。

**请求体**:
```json
{
  "modelId": "deepseek-chat"
}
```

**响应**:
```json
{
  "success": true,
  "data": {
    "success": true,
    "message": "连接成功",
    "statusCode": 200
  }
}
```

> `data.success` 表示实际连接是否成功；外层 `success` 固定为 `true` 表示测试流程本身执行完成。

---

#### POST /admin/api/test-key

测试指定 API Key 的连接是否可用（用于"添加新提供商"表单，无需提供商已保存）。通过服务端代理请求上游 `/models` 端点，避免浏览器跨域限制。

**请求体**:
```json
{
  "url": "https://api.deepseek.com",
  "apiKey": "sk-xxx",
  "apiType": "openai"
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `url` | ✅ | API 基础地址，尾部 `/` 会被自动去除 |
| `apiKey` | ✅ | 待测试的 API Key |
| `apiType` | ❌ | `openai`（默认）或 `anthropic` |

**成功响应**:
```json
{
  "success": true,
  "data": {
    "success": true,
    "statusCode": 200,
    "data": { "object": "list", "data": [...] }
  }
}
```

> 连接成功时 `data.data` 包含上游返回的模型列表；连接失败时 `data.success` 为 `false`，`statusCode` 为 `0`（网络错误）或具体 HTTP 状态码。

---

#### POST /admin/api/test-model

测试指定模型的连接是否可用（用于"添加新提供商"表单）。通过服务端代理请求上游 `/chat/completions` 或 `/messages` 端点，避免浏览器跨域限制。

**请求体**:
```json
{
  "url": "https://api.deepseek.com",
  "apiKey": "sk-xxx",
  "apiType": "openai",
  "model": "deepseek-chat"
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `url` | ✅ | API 基础地址 |
| `apiKey` | ✅ | 待测试的 API Key |
| `apiType` | ❌ | 决定使用 `/chat/completions`（openai）或 `/messages`（anthropic） |
| `model` | ✅ | 模型 ID |

**成功响应**:
```json
{
  "success": true,
  "data": {
    "success": true,
    "statusCode": 200
  }
}
```

---

#### GET /admin/api/proxy-keys

获取所有转发 API Key 列表。返回的 `key` 字段会做脱敏处理（仅显示前 8 位 + `****` + 后 4 位）。

**响应**:
```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "key": "sk_cf_xxxxxx****xxxx",
      "name": "测试 Key",
      "enabled": true,
      "createdAt": "2024-01-01T00:00:00.000Z",
      "expiresAt": null
    }
  ]
}
```

---

#### POST /admin/api/proxy-keys

生成新的转发 API Key。Key 格式为 `sk_cf_` + 32 位随机 hex，**仅在此响应中返回完整明文，之后不再可见**。

**请求体**（全部可选）:
```json
{
  "name": "我的Key名称",
  "expiresIn": "90d"
}
```

`expiresIn` 可选值：

| 值 | 有效期 |
|----|--------|
| `30d` | 30 天 |
| `90d` | 90 天 |
| `180d` | 180 天 |
| `1y` | 1 年（365 天） |
| `forever` | 永久（默认） |

**成功响应** (`201`):
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "key": "sk_cf_abcdef0123456789abcdef0123456789",
    "name": "我的Key名称",
    "enabled": true,
    "createdAt": "2024-01-01T00:00:00.000Z",
    "expiresAt": "2024-04-01T00:00:00.000Z"
  },
  "message": "请立即保存此 Key，关闭后将不再显示"
}
```

---

#### PATCH /admin/api/proxy-keys/:id

更新转发 Key 的启用状态。

**请求体**:
```json
{ "enabled": false }
```

**成功响应**: 返回更新后的 ProxyKey 对象（key 仍为完整值）。

**未找到** (`404`): `转发 Key 不存在`。

---

#### DELETE /admin/api/proxy-keys/:id

删除转发 API Key。

**成功响应**:
```json
{ "success": true, "message": "转发 Key 已删除" }
```

---

## 错误响应格式

所有 API 错误返回以下格式:

```json
{
  "error": {
    "message": "错误描述",
    "type": "error_type"
  }
}
```

部分错误（如所有 Key 耗尽）会附带 `detail` 字段：
```json
{
  "error": {
    "message": "所有 API Key 已用完，最后一次错误: HTTP 429",
    "type": "key_exhausted",
    "detail": "..."
  }
}
```

常见错误类型:

| 类型 | 说明 |
|------|------|
| `authentication_error` | 认证失败（缺少/无效 Token 或 Session） |
| `invalid_request_error` | 请求参数错误（如缺少 model、模型格式错误、提供商/模型不存在） |
| `provider_disabled` | 提供商已禁用 |
| `model_disabled` | 模型已禁用 |
| `model_forbidden` | 当前 API Key 不允许访问该模型（`allowedModels` 白名单拒绝） |
| `rate_limit_error` | 命中 RPM 限流（HTTP 429） |
| `quota_exceeded` | 命中日配额限流（HTTP 429） |
| `configuration_error` | 配置错误（如提供商未配置可用 API Key） |
| `key_exhausted` | 所有 API Key 均失败 |
| `proxy_error` | 转发过程出错（如网络异常） |
| `server_error` | 服务器内部错误 |
| `not_found` | 接口不存在（404） |

管理 API 的错误响应使用 `success: false` + `message` 的格式：

```json
{ "success": false, "message": "错误描述" }
```

---

## v2 新增：转发 Key 限流配额

转发 Key（`proxy_keys` 表 / `sk_cf_*`）在原有字段之外新增三个限流相关字段：

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `rpm` | integer | `0` | 每分钟最大请求数，`0` 表示不限 |
| `dailyQuota` | integer | `0` | 每日最大请求数（UTC 日），`0` 表示不限 |
| `allowedModels` | string[] | `[]` | 允许访问的模型前缀白名单，空数组表示全部允许；匹配规则：完整匹配 `openai/gpt-4o` 或前缀匹配 `openai/` |

限流窗口通过 SQLite `rate_counters` 表原子递增，无并发竞态。计数窗口：
- RPM：每 60 秒一个窗口
- daily：UTC 当天 0 点为一个窗口

超限时返回 429：

```json
// RPM 超限
{ "error": { "message": "请求过于频繁：当前 RPM 3 已超过限制 2/min", "type": "rate_limit_error" } }

// 日配额超限
{ "error": { "message": "今日请求次数 6 已超过配额 5/天", "type": "quota_exceeded" } }
```

---

## v2 新增：用量统计 API

#### GET /admin/api/usage/summary

获取用量汇总，支持时间范围过滤。

**查询参数**（均可选）:

| 参数 | 说明 |
|------|------|
| `from` | 起始时间（ISO 8601） |
| `to` | 结束时间（ISO 8601） |

**响应**:

```json
{
  "success": true,
  "data": {
    "totalRequests": 100,
    "totalSuccess": 95,
    "totalFailed": 5,
    "totalTokens": 12345,
    "byKey": [
      {
        "proxyKeyId": "uuid",
        "proxyKeyName": "测试 Key",
        "totalRequests": 50,
        "successRequests": 48,
        "failedRequests": 2,
        "totalTokens": 6000,
        "promptTokens": 4000,
        "completionTokens": 2000,
        "avgDurationMs": 850
      }
    ],
    "byProvider": [
      { "providerId": "openai", "totalRequests": 60, "successRequests": 58, "totalTokens": 8000 }
    ]
  }
}
```

#### GET /admin/api/usage/logs

获取用量日志明细（按 id 倒序）。

**查询参数**:

| 参数 | 默认 | 说明 |
|------|------|------|
| `limit` | `100` | 单页条数，最大 1000 |
| `offset` | `0` | 偏移量 |
| `from` | — | 起始时间（ISO 8601） |
| `to` | — | 结束时间（ISO 8601） |
| `keyId` | — | 按转发 Key ID 过滤 |
| `providerId` | — | 按提供商 ID 过滤 |

**响应**:

```json
{
  "success": true,
  "data": [
    {
      "id": 42,
      "proxyKeyId": "uuid",
      "proxyKeyName": "测试 Key",
      "providerId": "openai",
      "model": "openai/gpt-4o",
      "status": 200,
      "durationMs": 850,
      "promptTokens": 50,
      "completionTokens": 120,
      "totalTokens": 170,
      "stream": 0,
      "error": null,
      "createdAt": "2026-07-18T00:43:35.365Z"
    }
  ]
}
```

---

## v2 新增：Prometheus 指标

#### GET /metrics

返回 Prometheus 文本格式指标。若设置了 `METRICS_TOKEN` 环境变量，需要 Bearer Token 鉴权：`Authorization: Bearer <token>`。

**自定义指标**:

| 指标 | 类型 | 标签 | 说明 |
|------|------|------|------|
| `ai_gateway_requests_total` | Counter | `provider`, `status`, `stream` | 转发请求总数 |
| `ai_gateway_tokens_total` | Counter | `provider`, `type` | 消耗 token 总数（type=prompt/completion） |
| `ai_gateway_request_duration_ms` | Histogram | `provider` | 转发请求耗时（毫秒） |
| `ai_gateway_key_failures_total` | Counter | `provider` | 上游 API Key 失败次数 |
| `ai_gateway_rate_limit_hits_total` | Counter | `type` | 命中限流的请求次数（type=rpm/daily） |
| `ai_gateway_node_*` | — | — | Node.js 进程默认指标（CPU / GC / 内存等） |

**Prometheus scrape 配置示例**:

```yaml
scrape_configs:
  - job_name: 'ai-gateway'
    static_configs:
      - targets: ['your-host:8787']
    bearer_token: 'your-metrics-token'  # 若设置了 METRICS_TOKEN
```

---

## v2 新增：转发 Key 管理字段更新

#### POST /admin/api/proxy-keys（创建）

请求体新增可选字段：

```json
{
  "name": "我的Key",
  "expiresIn": "90d",
  "rpm": 60,
  "dailyQuota": 1000,
  "allowedModels": ["openai/", "anthropic/claude-sonnet-4-20250514"]
}
```

#### PATCH /admin/api/proxy-keys/:id（更新）

现在支持更新 name / enabled / rpm / dailyQuota / allowedModels：

```json
{
  "name": "新名称",
  "enabled": false,
  "rpm": 100,
  "dailyQuota": 2000,
  "allowedModels": ["openai/"]
}
```
