import { Context } from 'hono'
import {
  getProviders,
  getProvider,
  addProvider,
  updateProvider,
  deleteProvider,
  getProxyKeys,
  addProxyKey,
  updateProxyKey,
  deleteProxyKey,
  queryUsageLogs,
  getUsageSummaryByProxyKey,
  getUsageSummaryByProvider,
  type UsageSummaryRow,
  type ProviderUsageSummaryRow,
} from './storage'
import { testModelConnection } from './proxy'
import { PROXY_KEY_PREFIX, EXPIRY_OPTIONS } from './config'
import type {
  Env,
  ApiResponse,
  Provider,
  CreateProviderRequest,
  UpdateProviderRequest,
  CreateProxyKeyRequest,
  UpdateProxyKeyRequest,
  TestModelRequest,
} from './types'

// ===== 通用辅助 =====

/** 将 string[] 或正规对象数组统一转换为正规对象数组 */
function normalizeArray<T>(
  items: unknown,
  mapFn: (val: string) => T
): T[] {
  if (!Array.isArray(items)) return []
  if (items.length === 0 || typeof items[0] === 'string') {
    return (items as string[]).map(mapFn)
  }
  return items as T[]
}

// ===== 系统状态 =====

export function handleStatus(c: Context<{ Bindings: Env }>) {
  const providers = getProviders(c.env)
  const proxyKeys = getProxyKeys(c.env)

  const totalModels = providers.reduce((sum, p) => sum + p.models.length, 0)
  const enabledModels = providers.reduce(
    (sum, p) => sum + p.models.filter((m) => m.enabled).length,
    0
  )

  return c.json<ApiResponse>({
    success: true,
    data: {
      providersCount: providers.length,
      enabledProvidersCount: providers.filter((p) => p.enabled).length,
      modelsCount: totalModels,
      enabledModelsCount: enabledModels,
      proxyKeysCount: proxyKeys.filter((k) => k.enabled).length,
      adminConfigured: !!(c.env.ADMIN_USERNAME && c.env.ADMIN_PASSWORD),
      baseUrl: new URL(c.req.url).origin,
    },
  })
}

// ===== 提供商 CRUD =====

export function handleGetProviders(c: Context<{ Bindings: Env }>) {
  const providers = getProviders(c.env)
  return c.json<ApiResponse<Provider[]>>({ success: true, data: providers })
}

export async function handleCreateProvider(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json<CreateProviderRequest>()

  if (!body.id || !body.name || !body.baseUrl) {
    return c.json<ApiResponse>({ success: false, message: 'id、name、baseUrl 为必填项' }, 400)
  }

  const providers = getProviders(c.env)
  if (providers.some((p) => p.id === body.id)) {
    return c.json<ApiResponse>({ success: false, message: `提供商 id "${body.id}" 已存在` }, 409)
  }

  const now = new Date().toISOString()
  const provider: Provider = {
    id: body.id,
    name: body.name,
    baseUrl: body.baseUrl.replace(/\/$/, ''),
    apiType: body.apiType || 'openai',
    apiKeys: normalizeArray(body.apiKeys, (k) => ({ key: k, enabled: true })),
    models: body.models
      ? normalizeArray(body.models, (m) => ({ id: m, enabled: true }))
      : [],
    enabled: body.enabled !== undefined ? body.enabled : true,
    createdAt: now,
    updatedAt: now,
  }

  addProvider(c.env, provider)
  return c.json<ApiResponse<Provider>>({ success: true, data: provider }, 201)
}

export async function handleUpdateProvider(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const body = await c.req.json<UpdateProviderRequest>()

  const updates: Partial<Provider> = {}
  if (body.name !== undefined) updates.name = body.name
  if (body.baseUrl !== undefined) updates.baseUrl = body.baseUrl.replace(/\/$/, '')
  if (body.apiType !== undefined) updates.apiType = body.apiType
  if (body.apiKeys !== undefined) {
    updates.apiKeys = normalizeArray(body.apiKeys, (k) => ({ key: k, enabled: true }))
  }
  if (body.enabled !== undefined) updates.enabled = body.enabled
  if (body.models !== undefined) {
    updates.models = normalizeArray(body.models, (m) => ({ id: m, enabled: true }))
  }

  const updated = updateProvider(c.env, id, updates)
  if (!updated) {
    return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
  }

  return c.json<ApiResponse<Provider>>({ success: true, data: updated })
}

export function handleDeleteProvider(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const deleted = deleteProvider(c.env, id)
  if (!deleted) {
    return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
  }
  return c.json<ApiResponse>({ success: true, message: '提供商已删除' })
}

export async function handleTestModel(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const { modelId } = await c.req.json<TestModelRequest>()

  if (!modelId) {
    return c.json<ApiResponse>({ success: false, message: 'modelId 为必填项' }, 400)
  }

  const provider = getProvider(c.env, id)
  if (!provider) {
    return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
  }

  const modelConfig = provider.models.find((m) => m.id === modelId)
  if (!modelConfig) {
    return c.json<ApiResponse>({ success: false, message: `模型 "${modelId}" 不存在于提供商 "${provider.name}"` }, 404)
  }

  const enabledKeys = provider.apiKeys.filter((k) => k.enabled)
  if (enabledKeys.length === 0) {
    return c.json<ApiResponse>({ success: false, message: '该提供商未配置可用的 API Key' }, 400)
  }

  const apiKey = enabledKeys[0].key
  const result = await testModelConnection(provider.baseUrl, apiKey, modelId, provider.apiType)

  return c.json<ApiResponse>({
    success: true,
    data: result,
  })
}

// ===== Key / 模型连通性测试（通过服务端代理，避免 CORS） =====

function buildAuthHeaders(apiKey: string, apiType?: string): Record<string, string> {
  if (apiType === 'anthropic') {
    return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
  }
  if (apiType === 'google') {
    return { 'x-goog-api-key': apiKey }
  }
  return { Authorization: `Bearer ${apiKey}` }
}

export async function handleTestKeyNew(c: Context<{ Bindings: Env }>) {
  const { url, apiKey, apiType } = await c.req.json<{ url: string; apiKey: string; apiType?: string }>()
  if (!url || !apiKey) {
    return c.json<ApiResponse>({ success: false, message: 'url 和 apiKey 为必填项' }, 400)
  }

  const cleanBase = url.replace(/\/$/, '')
  try {
    const response = await fetch(`${cleanBase}/models`, {
      method: 'GET', headers: buildAuthHeaders(apiKey, apiType), signal: AbortSignal.timeout(15000),
    })

    let data: unknown = null
    if (response.ok) {
      try { data = await response.json() } catch { /* ignore */ }
    }

    return c.json<ApiResponse>({
      success: true,
      data: { success: response.ok, statusCode: response.status, data },
    })
  } catch (err) {
    return c.json<ApiResponse>({
      success: true,
      data: { success: false, statusCode: 0, message: (err as Error).message || '连接失败' },
    })
  }
}

export async function handleTestModelNew(c: Context<{ Bindings: Env }>) {
  const { url, apiKey, apiType, model } = await c.req.json<{ url: string; apiKey: string; apiType?: string; model: string }>()
  if (!url || !apiKey || !model) {
    return c.json<ApiResponse>({ success: false, message: 'url、apiKey、model 为必填项' }, 400)
  }

  const cleanBase = url.replace(/\/$/, '')
  const endpoint = apiType === 'anthropic' ? 'messages' : 'chat/completions'

  try {
    const response = await fetch(`${cleanBase}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...buildAuthHeaders(apiKey, apiType) },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(15000),
    })

    return c.json<ApiResponse>({
      success: true,
      data: { success: response.ok, statusCode: response.status },
    })
  } catch (err) {
    return c.json<ApiResponse>({
      success: true,
      data: { success: false, statusCode: 0, message: (err as Error).message || '连接失败' },
    })
  }
}

// ===== 转发 Key 管理 =====

function maskKey(key: string): string {
  return key.length > 12
    ? key.substring(0, 8) + '****' + key.substring(key.length - 4)
    : key
}

export function handleGetProxyKeys(c: Context<{ Bindings: Env }>) {
  const keys = getProxyKeys(c.env)
  const maskedKeys = keys.map((k) => ({
    ...k,
    key: maskKey(k.key),
  }))
  return c.json<ApiResponse>({ success: true, data: maskedKeys })
}

export async function handleCreateProxyKey(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json<CreateProxyKeyRequest>()
  const id = crypto.randomUUID()
  const randomPart = crypto.randomUUID().replace(/-/g, '')
  const key = `${PROXY_KEY_PREFIX}${randomPart}`

  // 计算过期时间
  let expiresAt: string | null = null
  if (body.expiresIn && body.expiresIn !== 'forever') {
    const ttl = EXPIRY_OPTIONS[body.expiresIn]
    if (ttl) {
      expiresAt = new Date(Date.now() + ttl * 1000).toISOString()
    }
  }

  const proxyKey = {
    id,
    key,
    name: body.name || `Key-${new Date().toLocaleDateString()}`,
    enabled: true,
    createdAt: new Date().toISOString(),
    expiresAt,
    rpm: typeof body.rpm === 'number' && body.rpm > 0 ? Math.floor(body.rpm) : 0,
    dailyQuota: typeof body.dailyQuota === 'number' && body.dailyQuota > 0 ? Math.floor(body.dailyQuota) : 0,
    allowedModels: Array.isArray(body.allowedModels) ? body.allowedModels.filter((s) => typeof s === 'string') : [],
  }

  addProxyKey(c.env, proxyKey)
  return c.json<ApiResponse>({
    success: true,
    data: proxyKey,
    message: '请立即保存此 Key，关闭后将不再显示',
  }, 201)
}

export function handleDeleteProxyKey(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const deleted = deleteProxyKey(c.env, id)
  if (!deleted) {
    return c.json<ApiResponse>({ success: false, message: '转发 Key 不存在' }, 404)
  }
  return c.json<ApiResponse>({ success: true, message: '转发 Key 已删除' })
}

export async function handleUpdateProxyKey(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const body = await c.req.json<UpdateProxyKeyRequest>()

  const updates: Partial<import('./types').ProxyKey> = {}
  if (body.name !== undefined) updates.name = body.name
  if (body.enabled !== undefined) updates.enabled = body.enabled
  if (body.rpm !== undefined) updates.rpm = Math.max(0, Math.floor(body.rpm))
  if (body.dailyQuota !== undefined) updates.dailyQuota = Math.max(0, Math.floor(body.dailyQuota))
  if (body.allowedModels !== undefined) updates.allowedModels = body.allowedModels.filter((s) => typeof s === 'string')

  const updated = updateProxyKey(c.env, id, updates)
  if (!updated) {
    return c.json<ApiResponse>({ success: false, message: '转发 Key 不存在' }, 404)
  }
  // 返回时把完整 key 也带回来，便于 UI 展示（已登录管理员可看）
  return c.json<ApiResponse>({ success: true, data: { ...updated, key: maskKey(updated.key) } })
}

// ===== 用量统计 API =====

export function handleUsageSummary(c: Context<{ Bindings: Env }>) {
  const fromIso = c.req.query('from') || undefined
  const toIso = c.req.query('to') || undefined
  const byKey = getUsageSummaryByProxyKey(c.env, fromIso, toIso) as UsageSummaryRow[]
  const byProvider = getUsageSummaryByProvider(c.env, fromIso, toIso) as ProviderUsageSummaryRow[]

  const totalRequests = byKey.reduce((s, r) => s + r.totalRequests, 0)
  const totalSuccess = byKey.reduce((s, r) => s + r.successRequests, 0)
  const totalFailed = byKey.reduce((s, r) => s + r.failedRequests, 0)
  const totalTokens = byKey.reduce((s, r) => s + r.totalTokens, 0)

  return c.json<ApiResponse>({
    success: true,
    data: {
      totalRequests,
      totalSuccess,
      totalFailed,
      totalTokens,
      byKey,
      byProvider,
    },
  })
}

export function handleUsageLogs(c: Context<{ Bindings: Env }>) {
  const limit = Math.min(Number(c.req.query('limit')) || 100, 1000)
  const offset = Math.max(Number(c.req.query('offset')) || 0, 0)
  const fromIso = c.req.query('from') || undefined
  const toIso = c.req.query('to') || undefined
  const proxyKeyId = c.req.query('keyId') || undefined
  const providerId = c.req.query('providerId') || undefined

  const logs = queryUsageLogs(c.env, { limit, offset, fromIso, toIso, proxyKeyId, providerId })
  return c.json<ApiResponse>({ success: true, data: logs })
}
