import type { DB } from './db'
import type { Env, Provider, ProxyKey, Session, UsageLog } from './types'
import { DEFAULT_PROVIDERS, PROXY_KEY_PREFIX } from './config'

// ===== 通用辅助 =====

interface ProviderRow {
  id: string
  name: string
  base_url: string
  api_type: string
  api_keys: string
  models: string
  enabled: number
  created_at: string
  updated_at: string
}

interface ProxyKeyRow {
  id: string
  key: string
  name: string
  enabled: number
  created_at: string
  expires_at: string | null
  rpm: number
  daily_quota: number
  allowed_models: string
}

function rowToProvider(row: ProviderRow): Provider {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    apiType: row.api_type as Provider['apiType'],
    apiKeys: JSON.parse(row.api_keys),
    models: JSON.parse(row.models),
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToProxyKey(row: ProxyKeyRow): ProxyKey {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    rpm: row.rpm,
    dailyQuota: row.daily_quota,
    allowedModels: JSON.parse(row.allowed_models),
  }
}

// ===== 提供商 CRUD =====

export function getProviders(env: Env): Provider[] {
  const rows = env.db.prepare('SELECT * FROM providers').all() as ProviderRow[]
  return rows.map(rowToProvider)
}

export function getProvider(env: Env, id: string): Provider | null {
  const row = env.db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as ProviderRow | undefined
  return row ? rowToProvider(row) : null
}

export function setProviders(env: Env, providers: Provider[]): void {
  const tx = env.db.transaction((list: Provider[]) => {
    env.db.prepare('DELETE FROM providers').run()
    const stmt = env.db.prepare(`
      INSERT INTO providers (id, name, base_url, api_type, api_keys, models, enabled, created_at, updated_at)
      VALUES (@id, @name, @base_url, @api_type, @api_keys, @models, @enabled, @created_at, @updated_at)
    `)
    for (const p of list) {
      stmt.run({
        id: p.id,
        name: p.name,
        base_url: p.baseUrl,
        api_type: p.apiType || 'openai',
        api_keys: JSON.stringify(p.apiKeys),
        models: JSON.stringify(p.models),
        enabled: p.enabled ? 1 : 0,
        created_at: p.createdAt,
        updated_at: p.updatedAt,
      })
    }
  })
  tx(providers)
}

export function addProvider(env: Env, provider: Provider): void {
  env.db.prepare(`
    INSERT INTO providers (id, name, base_url, api_type, api_keys, models, enabled, created_at, updated_at)
    VALUES (@id, @name, @base_url, @api_type, @api_keys, @models, @enabled, @created_at, @updated_at)
  `).run({
    id: provider.id,
    name: provider.name,
    base_url: provider.baseUrl,
    api_type: provider.apiType || 'openai',
    api_keys: JSON.stringify(provider.apiKeys),
    models: JSON.stringify(provider.models),
    enabled: provider.enabled ? 1 : 0,
    created_at: provider.createdAt,
    updated_at: provider.updatedAt,
  })
}

export function updateProvider(env: Env, id: string, updates: Partial<Provider>): Provider | null {
  const existing = getProvider(env, id)
  if (!existing) return null
  const merged: Provider = {
    ...existing,
    ...updates,
    updatedAt: new Date().toISOString(),
  }
  env.db.prepare(`
    UPDATE providers
    SET name = @name, base_url = @base_url, api_type = @api_type,
        api_keys = @api_keys, models = @models, enabled = @enabled,
        updated_at = @updated_at
    WHERE id = @id
  `).run({
    id: merged.id,
    name: merged.name,
    base_url: merged.baseUrl,
    api_type: merged.apiType || 'openai',
    api_keys: JSON.stringify(merged.apiKeys),
    models: JSON.stringify(merged.models),
    enabled: merged.enabled ? 1 : 0,
    updated_at: merged.updatedAt,
  })
  return merged
}

export function deleteProvider(env: Env, id: string): boolean {
  // 同时清理该提供商下的 key_health 记录
  const tx = env.db.transaction(() => {
    const r = env.db.prepare('DELETE FROM providers WHERE id = ?').run(id)
    env.db.prepare('DELETE FROM key_health WHERE provider_id = ?').run(id)
    return r.changes > 0
  })
  return tx()
}

// ===== Session 管理 =====

export function createSession(env: Env, username: string, ttlSeconds: number): string {
  const sessionId = crypto.randomUUID()
  const session: Session = {
    username,
    expiresAt: Date.now() + ttlSeconds * 1000,
  }
  env.db.prepare(`
    INSERT INTO sessions (session_id, username, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `).run(sessionId, username, session.expiresAt, new Date().toISOString())
  return sessionId
}

export function getSession(env: Env, sessionId: string): Session | null {
  const row = env.db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId) as
    | { username: string; expires_at: number }
    | undefined
  if (!row) return null
  if (row.expires_at < Date.now()) {
    deleteSession(env, sessionId)
    return null
  }
  return { username: row.username, expiresAt: row.expires_at }
}

export function deleteSession(env: Env, sessionId: string): void {
  env.db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId)
}

// ===== 转发 Key =====

export function getProxyKeys(env: Env): ProxyKey[] {
  const rows = env.db.prepare('SELECT * FROM proxy_keys').all() as ProxyKeyRow[]
  return rows.map(rowToProxyKey)
}

export function addProxyKey(env: Env, key: ProxyKey): void {
  env.db.prepare(`
    INSERT INTO proxy_keys (id, key, name, enabled, created_at, expires_at, rpm, daily_quota, allowed_models)
    VALUES (@id, @key, @name, @enabled, @created_at, @expires_at, @rpm, @daily_quota, @allowed_models)
  `).run({
    id: key.id,
    key: key.key,
    name: key.name,
    enabled: key.enabled ? 1 : 0,
    created_at: key.createdAt,
    expires_at: key.expiresAt ?? null,
    rpm: key.rpm ?? 0,
    daily_quota: key.dailyQuota ?? 0,
    allowed_models: JSON.stringify(key.allowedModels ?? []),
  })
}

export function deleteProxyKey(env: Env, id: string): boolean {
  const r = env.db.prepare('DELETE FROM proxy_keys WHERE id = ?').run(id)
  return r.changes > 0
}

export function updateProxyKey(env: Env, id: string, updates: Partial<ProxyKey>): ProxyKey | null {
  const existing = getProxyKeyById(env, id)
  if (!existing) return null
  const merged: ProxyKey = { ...existing, ...updates }
  env.db.prepare(`
    UPDATE proxy_keys
    SET name = @name, enabled = @enabled, expires_at = @expires_at,
        rpm = @rpm, daily_quota = @daily_quota, allowed_models = @allowed_models
    WHERE id = @id
  `).run({
    id: merged.id,
    name: merged.name,
    enabled: merged.enabled ? 1 : 0,
    expires_at: merged.expiresAt ?? null,
    rpm: merged.rpm ?? 0,
    daily_quota: merged.dailyQuota ?? 0,
    allowed_models: JSON.stringify(merged.allowedModels ?? []),
  })
  return merged
}

export function getProxyKeyById(env: Env, id: string): ProxyKey | null {
  const row = env.db.prepare('SELECT * FROM proxy_keys WHERE id = ?').get(id) as ProxyKeyRow | undefined
  return row ? rowToProxyKey(row) : null
}

/** 校验转发 Key 并返回完整对象（用于限流/配额上下文），无效返回 null */
export function validateProxyKey(env: Env, key: string): ProxyKey | null {
  const row = env.db.prepare('SELECT * FROM proxy_keys WHERE key = ?').get(key) as ProxyKeyRow | undefined
  if (!row) return null
  if (row.enabled !== 1) return null
  if (row.expires_at) {
    if (Date.now() >= new Date(row.expires_at).getTime()) return null
  }
  return rowToProxyKey(row)
}

// ===== Key 健康状态 =====

interface KeyHealthRow {
  provider_id: string
  api_key: string
  failures: number
  last_failed: number
  demoted_at: number | null
}

export interface KeyHealth {
  failures: number
  lastFailed: boolean
  demotedAt?: number
}

export type HealthMap = Record<string, KeyHealth>

export function readHealth(env: Env, providerId: string): HealthMap {
  const rows = env.db.prepare('SELECT * FROM key_health WHERE provider_id = ?').all(providerId) as KeyHealthRow[]
  const map: HealthMap = {}
  for (const r of rows) {
    map[r.api_key] = {
      failures: r.failures,
      lastFailed: r.last_failed === 1,
      demotedAt: r.demoted_at ?? undefined,
    }
  }
  return map
}

/** 落盘整张 map（覆盖式）。空 map 时清空该 provider 的健康记录。 */
export function writeHealth(env: Env, providerId: string, health: HealthMap): void {
  const tx = env.db.transaction((pid: string, h: HealthMap) => {
    env.db.prepare('DELETE FROM key_health WHERE provider_id = ?').run(pid)
    const stmt = env.db.prepare(`
      INSERT INTO key_health (provider_id, api_key, failures, last_failed, demoted_at)
      VALUES (?, ?, ?, ?, ?)
    `)
    for (const [apiKey, v] of Object.entries(h)) {
      if (v.failures > 0) {
        stmt.run(pid, apiKey, v.failures, v.lastFailed ? 1 : 0, v.demotedAt ?? null)
      }
    }
  })
  tx(providerId, health)
}

/** 只更新单个 key 的健康记录（避免整张 map 重写，降低写放大） */
export function upsertKeyHealth(
  env: Env,
  providerId: string,
  apiKey: string,
  health: KeyHealth
): void {
  env.db.prepare(`
    INSERT INTO key_health (provider_id, api_key, failures, last_failed, demoted_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(provider_id, api_key) DO UPDATE SET
      failures = excluded.failures,
      last_failed = excluded.last_failed,
      demoted_at = excluded.demoted_at
  `).run(providerId, apiKey, health.failures, health.lastFailed ? 1 : 0, health.demotedAt ?? null)
}

export function deleteKeyHealth(env: Env, providerId: string, apiKey: string): void {
  env.db.prepare('DELETE FROM key_health WHERE provider_id = ? AND api_key = ?').run(providerId, apiKey)
}

// ===== 限流计数器 =====

interface RateCounterRow {
  key_id: string
  window_start: number
  count: number
}

/**
 * 原子地递增指定窗口的请求计数，并返回递增后的值。
 * 同时返回另一个窗口的当前计数，便于一次调用同时检查 RPM + dailyQuota。
 */
export function incrementRateCounter(
  env: Env,
  keyId: string,
  rpmWindowStart: number,
  dailyWindowStart: number
): { rpmCount: number; dailyCount: number } {
  const tx = env.db.transaction(() => {
    // 递增 RPM 窗口
    env.db.prepare(`
      INSERT INTO rate_counters (key_id, window_start, count) VALUES (?, ?, 1)
      ON CONFLICT(key_id, window_start) DO UPDATE SET count = count + 1
    `).run(keyId, rpmWindowStart)
    // 递增 daily 窗口
    env.db.prepare(`
      INSERT INTO rate_counters (key_id, window_start, count) VALUES (?, ?, 1)
      ON CONFLICT(key_id, window_start) DO UPDATE SET count = count + 1
    `).run(keyId, dailyWindowStart)

    const rpmRow = env.db.prepare('SELECT count FROM rate_counters WHERE key_id = ? AND window_start = ?').get(keyId, rpmWindowStart) as RateCounterRow
    const dailyRow = env.db.prepare('SELECT count FROM rate_counters WHERE key_id = ? AND window_start = ?').get(keyId, dailyWindowStart) as RateCounterRow
    return { rpmCount: rpmRow.count, dailyCount: dailyRow.count }
  })
  return tx()
}

/** 清理过期的限流计数器（window_start 早于给定时间戳） */
export function purgeRateCounters(env: Env, olderThanMs: number): number {
  const r = env.db.prepare('DELETE FROM rate_counters WHERE window_start < ?').run(olderThanMs)
  return r.changes
}

// ===== 用量日志 =====

export interface InsertUsageLogInput {
  proxyKeyId: string
  proxyKeyName: string
  providerId: string
  model: string
  status: number
  durationMs: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  stream: boolean
  error: string | null
}

export function insertUsageLog(env: Env, input: InsertUsageLogInput): void {
  env.db.prepare(`
    INSERT INTO usage_logs
      (proxy_key_id, proxy_key_name, provider_id, model, status, duration_ms,
       prompt_tokens, completion_tokens, total_tokens, stream, error, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.proxyKeyId,
    input.proxyKeyName,
    input.providerId,
    input.model,
    input.status,
    input.durationMs,
    input.promptTokens,
    input.completionTokens,
    input.totalTokens,
    input.stream ? 1 : 0,
    input.error,
    new Date().toISOString()
  )
}

export interface UsageQueryOptions {
  proxyKeyId?: string
  providerId?: string
  fromIso?: string
  toIso?: string
  limit?: number
  offset?: number
}

export function queryUsageLogs(env: Env, opts: UsageQueryOptions): UsageLog[] {
  const where: string[] = []
  const params: unknown[] = []
  if (opts.proxyKeyId) { where.push('proxy_key_id = ?'); params.push(opts.proxyKeyId) }
  if (opts.providerId) { where.push('provider_id = ?'); params.push(opts.providerId) }
  if (opts.fromIso) { where.push('created_at >= ?'); params.push(opts.fromIso) }
  if (opts.toIso) { where.push('created_at <= ?'); params.push(opts.toIso) }
  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : ''
  const limit = opts.limit ?? 100
  const offset = opts.offset ?? 0
  const rows = env.db.prepare(
    `SELECT * FROM usage_logs ${whereClause} ORDER BY id DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset) as Array<Record<string, unknown>>
  return rows.map(rowToUsageLog)
}

export interface UsageSummaryRow {
  proxyKeyId: string
  proxyKeyName: string
  totalRequests: number
  successRequests: number
  failedRequests: number
  totalTokens: number
  promptTokens: number
  completionTokens: number
  avgDurationMs: number
}

export function getUsageSummaryByProxyKey(env: Env, fromIso?: string, toIso?: string): UsageSummaryRow[] {
  const where: string[] = []
  const params: unknown[] = []
  if (fromIso) { where.push('created_at >= ?'); params.push(fromIso) }
  if (toIso) { where.push('created_at <= ?'); params.push(toIso) }
  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : ''
  const rows = env.db.prepare(`
    SELECT
      proxy_key_id            AS proxyKeyId,
      proxy_key_name          AS proxyKeyName,
      COUNT(*)                AS totalRequests,
      SUM(CASE WHEN status >= 200 AND status < 300 THEN 1 ELSE 0 END) AS successRequests,
      SUM(CASE WHEN status >= 200 AND status < 300 THEN 0 ELSE 1 END) AS failedRequests,
      COALESCE(SUM(total_tokens), 0)      AS totalTokens,
      COALESCE(SUM(prompt_tokens), 0)     AS promptTokens,
      COALESCE(SUM(completion_tokens), 0) AS completionTokens,
      COALESCE(CAST(AVG(duration_ms) AS INTEGER), 0) AS avgDurationMs
    FROM usage_logs ${whereClause}
    GROUP BY proxy_key_id, proxy_key_name
    ORDER BY totalRequests DESC
  `).all(...params) as UsageSummaryRow[]
  return rows
}

export interface ProviderUsageSummaryRow {
  providerId: string
  totalRequests: number
  successRequests: number
  totalTokens: number
}

export function getUsageSummaryByProvider(env: Env, fromIso?: string, toIso?: string): ProviderUsageSummaryRow[] {
  const where: string[] = []
  const params: unknown[] = []
  if (fromIso) { where.push('created_at >= ?'); params.push(fromIso) }
  if (toIso) { where.push('created_at <= ?'); params.push(toIso) }
  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : ''
  return env.db.prepare(`
    SELECT
      provider_id  AS providerId,
      COUNT(*)     AS totalRequests,
      SUM(CASE WHEN status >= 200 AND status < 300 THEN 1 ELSE 0 END) AS successRequests,
      COALESCE(SUM(total_tokens), 0) AS totalTokens
    FROM usage_logs ${whereClause}
    GROUP BY provider_id
    ORDER BY totalRequests DESC
  `).all(...params) as ProviderUsageSummaryRow[]
}

function rowToUsageLog(row: Record<string, unknown>): UsageLog {
  return {
    id: row.id as number,
    proxyKeyId: row.proxy_key_id as string,
    proxyKeyName: row.proxy_key_name as string,
    providerId: row.provider_id as string,
    model: row.model as string,
    status: row.status as number,
    durationMs: row.duration_ms as number,
    promptTokens: row.prompt_tokens as number,
    completionTokens: row.completion_tokens as number,
    totalTokens: row.total_tokens as number,
    stream: row.stream as number,
    error: (row.error as string | null) ?? null,
    createdAt: row.created_at as string,
  }
}

/** 清理超期用量日志 */
export function purgeUsageLogs(env: Env, olderThanIso: string): number {
  const r = env.db.prepare('DELETE FROM usage_logs WHERE created_at < ?').run(olderThanIso)
  return r.changes
}

// ===== 初始数据填充 =====

export function seedInitialData(env: Env): void {
  const providers = getProviders(env)
  if (providers.length > 0) return

  const seeded: Provider[] = DEFAULT_PROVIDERS.map((p) => ({
    ...p,
    apiKeys: p.apiKeys,
    models: p.models.map((m) => ({ ...m, enabled: true })),
  }))
  setProviders(env, seeded)

  // 创建一个测试转发 Key
  const keys = getProxyKeys(env)
  if (keys.length === 0) {
    const testKey: ProxyKey = {
      id: crypto.randomUUID(),
      key: `${PROXY_KEY_PREFIX}${crypto.randomUUID().replace(/-/g, '').substring(0, 32)}`,
      name: '测试 Key',
      enabled: true,
      createdAt: new Date().toISOString(),
      expiresAt: null,
      rpm: 0,
      dailyQuota: 0,
      allowedModels: [],
    }
    addProxyKey(env, testKey)
  }
}

/** 暴露 db 句柄供需要直接访问的场景使用 */
export function getDb(env: Env): DB {
  return env.db
}
