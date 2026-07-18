import { Context } from 'hono'
import promClient from 'prom-client'
import type { Env } from './types'

// ===== Prometheus 指标定义 =====

const registry = new promClient.Registry()

// 默认 Node.js 进程指标（CPU / 内存 / GC 等）
promClient.collectDefaultMetrics({ register: registry, prefix: 'ai_gateway_node_' })

const requestsTotal = new promClient.Counter({
  name: 'ai_gateway_requests_total',
  help: '转发请求总数',
  labelNames: ['provider', 'status', 'stream'] as const,
  registers: [registry],
})

const tokensTotal = new promClient.Counter({
  name: 'ai_gateway_tokens_total',
  help: '消耗 token 总数',
  labelNames: ['provider', 'type'] as const, // type: prompt | completion
  registers: [registry],
})

const requestDurationMs = new promClient.Histogram({
  name: 'ai_gateway_request_duration_ms',
  help: '转发请求耗时（毫秒）',
  labelNames: ['provider'] as const,
  buckets: [50, 100, 250, 500, 1000, 2000, 5000, 10000, 30000, 60000],
  registers: [registry],
})

const keyFailuresTotal = new promClient.Counter({
  name: 'ai_gateway_key_failures_total',
  help: '上游 API Key 失败次数',
  labelNames: ['provider'] as const,
  registers: [registry],
})

const rateLimitHitsTotal = new promClient.Counter({
  name: 'ai_gateway_rate_limit_hits_total',
  help: '命中 RPM / 日配额限流的请求次数',
  labelNames: ['type'] as const, // type: rpm | daily
  registers: [registry],
})

// ===== 上报接口 =====

export interface ProxyOutcome {
  providerId: string
  status: number
  durationMs: number
  tokens: number
  stream: boolean
}

export function recordProxyOutcome(o: ProxyOutcome): void {
  const streamLabel = o.stream ? 'true' : 'false'
  try {
    requestsTotal.inc({ provider: o.providerId, status: String(o.status), stream: streamLabel })
    requestDurationMs.observe({ provider: o.providerId }, o.durationMs)
    if (o.tokens > 0) {
      // 单独的成功调用才有 token 计数；这里 tokens 是 totalTokens，
      // 拆分由 proxy.ts 在解析 usage 后调用 recordTokens 完成
    }
    if (o.status >= 500 || o.status === 401 || o.status === 403) {
      keyFailuresTotal.inc({ provider: o.providerId })
    }
  } catch (e) {
    console.error('[metrics] recordProxyOutcome failed:', e)
  }
}

export function recordTokens(providerId: string, promptTokens: number, completionTokens: number): void {
  try {
    if (promptTokens > 0) tokensTotal.inc({ provider: providerId, type: 'prompt' }, promptTokens)
    if (completionTokens > 0) tokensTotal.inc({ provider: providerId, type: 'completion' }, completionTokens)
  } catch (e) {
    console.error('[metrics] recordTokens failed:', e)
  }
}

export function recordRateLimitHit(type: 'rpm' | 'daily'): void {
  try {
    rateLimitHitsTotal.inc({ type })
  } catch (e) {
    console.error('[metrics] recordRateLimitHit failed:', e)
  }
}

// ===== /metrics 端点 =====

/**
 * 暴露 Prometheus 指标。
 * 若设置了 METRICS_TOKEN 环境变量，则需要 Bearer Token 鉴权。
 */
export async function handleMetrics(c: Context<{ Bindings: Env }>): Promise<Response> {
  const expectedToken = process.env.METRICS_TOKEN
  if (expectedToken) {
    const auth = c.req.header('Authorization') || ''
    const provided = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    if (provided !== expectedToken) {
      return new Response('Unauthorized', { status: 401 })
    }
  }
  const body = await registry.metrics()
  return new Response(body, {
    headers: {
      'Content-Type': registry.contentType,
      'Cache-Control': 'no-store',
    },
  })
}
