import type { DB } from './db'

export interface Model {
  id: string
  enabled: boolean
}

export interface ApiKeyEntry {
  key: string
  enabled: boolean
}

export interface Provider {
  id: string
  name: string
  baseUrl: string
  apiType?: 'openai' | 'anthropic' | 'google'
  apiKeys: ApiKeyEntry[]
  models: Model[]
  enabled: boolean
  createdAt: string
  updatedAt: string
}

/**
 * 转发 Key — 客户端访问网关使用的 sk_cf_* Key
 * - rpm: 每分钟最大请求数（0 表示不限）
 * - dailyQuota: 每日最大请求数（0 表示不限）
 * - allowedModels: 允许访问的模型前缀白名单，空数组表示全部允许
 */
export interface ProxyKey {
  id: string
  key: string
  name: string
  enabled: boolean
  createdAt: string
  expiresAt?: string | null
  rpm: number
  dailyQuota: number
  allowedModels: string[]
}

export interface Session {
  username: string
  expiresAt: number
}

export interface ProxyRequestBody {
  model?: string
  messages?: Array<{ role: string; content: string }>
  stream?: boolean
  [key: string]: unknown
}

export interface TestModelRequest {
  modelId: string
}

export interface CreateProviderRequest {
  id: string
  name: string
  baseUrl: string
  apiType?: 'openai' | 'anthropic' | 'google'
  apiKeys?: Array<{ key: string; enabled: boolean }>
  models?: Array<{ id: string; enabled: boolean }> | string[]
  enabled?: boolean
}

export interface UpdateProviderRequest {
  name?: string
  baseUrl?: string
  apiType?: 'openai' | 'anthropic' | 'google'
  apiKeys?: Array<{ key: string; enabled: boolean }>
  models?: Array<{ id: string; enabled: boolean }> | string[]
  enabled?: boolean
}

export interface CreateProxyKeyRequest {
  name?: string
  expiresIn?: string // '30d' | '90d' | '180d' | '1y' | 'forever'
  rpm?: number
  dailyQuota?: number
  allowedModels?: string[]
}

export interface UpdateProxyKeyRequest {
  name?: string
  enabled?: boolean
  rpm?: number
  dailyQuota?: number
  allowedModels?: string[]
}

export interface ApiResponse<T = unknown> {
  success: boolean
  data?: T
  message?: string
}

/** 用量日志条目 — 每次成功/失败转发记录一条 */
export interface UsageLog {
  id: number
  proxyKeyId: string
  proxyKeyName: string
  providerId: string
  model: string
  status: number
  durationMs: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  stream: number // 0/1
  error: string | null
  createdAt: string
}

/** 已通过验证的 Proxy Key 上下文，挂在 c.var.proxyKey 上 */
export interface ProxyKeyContext {
  id: string
  name: string
  rpm: number
  dailyQuota: number
  allowedModels: string[]
}

/**
 * 应用运行时环境。Node 版本中 Hono 的 Bindings 直接持有这些对象，
 * 不再走 Cloudflare Workers env 注入。
 */
export interface Env {
  db: DB
  ADMIN_USERNAME?: string
  ADMIN_PASSWORD?: string
}
