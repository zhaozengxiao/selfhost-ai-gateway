import { Context } from 'hono'
import {
  getProvider,
  getProviders,
  readHealth,
  upsertKeyHealth,
  deleteKeyHealth,
  insertUsageLog,
  type KeyHealth,
} from './storage'
import { KEY_HEALTH_COOLDOWN_MS, KEY_HEALTH_MAX_FAILURES, UPSTREAM_TIMEOUT_MS } from './config'
import { isModelAllowed } from './auth'
import { recordProxyOutcome, recordTokens } from './metrics'
import type { Env, ProxyRequestBody, ProxyKeyContext } from './types'

/** 解析模型 ID，如 "deepseek/deepseek-chat" → { providerId, modelId } */
function parseModelId(model: string): { providerId: string; modelId: string } | null {
  const slashIndex = model.indexOf('/')
  if (slashIndex === -1) return null
  return {
    providerId: model.substring(0, slashIndex),
    modelId: model.substring(slashIndex + 1),
  }
}

/** 测试模型连接，发送最小请求验证 */
export async function testModelConnection(
  baseUrl: string,
  apiKey: string,
  modelId: string,
  apiType?: 'openai' | 'anthropic' | 'google'
): Promise<{ success: boolean; message: string; statusCode?: number }> {
  try {
    const cleanBase = baseUrl.replace(/\/$/, '')
    let endpoint: string
    let headers: Record<string, string> = { 'Content-Type': 'application/json' }
    let body: Record<string, unknown>

    if (apiType === 'anthropic') {
      endpoint = 'messages'
      headers['x-api-key'] = apiKey
      headers['anthropic-version'] = '2023-06-01'
      body = { model: modelId, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }
    } else if (apiType === 'google') {
      endpoint = `models/${modelId}:generateContent`
      headers['x-goog-api-key'] = apiKey
      body = { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }
    } else {
      endpoint = 'chat/completions'
      headers['Authorization'] = `Bearer ${apiKey}`
      body = { model: modelId, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }
    }

    const url = `${cleanBase}/${endpoint}`

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    })

    if (response.ok) {
      return { success: true, message: '连接成功', statusCode: response.status }
    }

    let errorBody = ''
    try {
      const errorData = await response.json() as { error?: { message?: string } }
      errorBody = errorData?.error?.message || JSON.stringify(errorData)
    } catch {
      errorBody = await response.text()
    }

    return {
      success: false,
      message: `HTTP ${response.status}: ${errorBody.substring(0, 200)}`,
      statusCode: response.status,
    }
  } catch (err) {
    const error = err as Error
    return {
      success: false,
      message: `连接失败: ${error.message?.substring(0, 200) || '未知错误'}`,
    }
  }
}

/** 从响应体提取 token 用量（OpenAI / Anthropic 兼容） */
function extractUsage(
  body: unknown,
  apiType?: string
): { promptTokens: number; completionTokens: number; totalTokens: number } {
  const zero = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
  if (!body || typeof body !== 'object') return zero
  const u = (body as { usage?: Record<string, unknown> }).usage
  if (!u) return zero
  if (apiType === 'anthropic') {
    const inputTokens = Number(u.input_tokens) || 0
    const outputTokens = Number(u.output_tokens) || 0
    return {
      promptTokens: inputTokens,
      completionTokens: outputTokens,
      totalTokens: inputTokens + outputTokens,
    }
  }
  const promptTokens = Number(u.prompt_tokens) || 0
  const completionTokens = Number(u.completion_tokens) || 0
  const totalTokens = Number(u.total_tokens) || (promptTokens + completionTokens)
  return { promptTokens, completionTokens, totalTokens }
}

function buildUpstreamHeaders(provider: { apiType?: string }, apiKey: string): Record<string, string> {
  if (provider.apiType === 'anthropic') {
    return {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    }
  }
  if (provider.apiType === 'google') {
    return {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    }
  }
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  }
}

/** 将 OpenAI 格式请求转换为 Google Gemini 格式 */
function convertOpenAIRequestToGemini(body: ProxyRequestBody): { payload: Record<string, unknown>; hasSystemInstruction: boolean } {
  const payload: Record<string, unknown> = {}
  let hasSystemInstruction = false

  if (body.messages && Array.isArray(body.messages)) {
    const contents: Record<string, unknown>[] = []
    let systemContent: string | null = null

    for (const msg of body.messages) {
      if (msg.role === 'user') {
        contents.push({
          role: 'user',
          parts: [{ text: String(msg.content || '') }],
        })
      } else if (msg.role === 'assistant') {
        contents.push({
          role: 'model',
          parts: [{ text: String(msg.content || '') }],
        })
      } else if (msg.role === 'system') {
        systemContent = String(msg.content || '')
      }
    }

    if (systemContent) {
      payload.systemInstruction = {
        parts: [{ text: systemContent }],
      }
      hasSystemInstruction = true
    }

    if (contents.length > 0) {
      payload.contents = contents
    }
  }

  const genConfig: Record<string, unknown> = {}
  if (typeof body.max_tokens === 'number') {
    genConfig.maxOutputTokens = body.max_tokens
  }
  if (typeof body.temperature === 'number') {
    genConfig.temperature = body.temperature
  }
  if (typeof body.top_p === 'number') {
    genConfig.topP = body.top_p
  }
  if (typeof body.top_k === 'number') {
    genConfig.topK = body.top_k
  }
  if (typeof body.stop === 'string') {
    genConfig.stopSequences = [body.stop]
  } else if (Array.isArray(body.stop)) {
    genConfig.stopSequences = body.stop
  }
  if (Object.keys(genConfig).length > 0) {
    payload.generationConfig = genConfig
  }

  return { payload, hasSystemInstruction }
}

/** 将 Google Gemini 响应转换为 OpenAI 格式 */
function convertGeminiResponseToOpenAI(parsed: unknown, model: string): string {
  const obj = parsed as Record<string, unknown>
  const candidates = obj.candidates as Array<Record<string, unknown>>
  const usageMeta = obj.usageMetadata as Record<string, unknown>

  const content = candidates?.[0]?.content as Record<string, unknown>
  const parts = content?.parts as Array<Record<string, unknown>>
  const text = parts?.[0]?.text as string || ''
  const finishReason = candidates?.[0]?.finishReason as string || 'stop'

  const openAIResponse = {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: text,
      },
      finish_reason: finishReason.toLowerCase(),
    }],
    usage: {
      prompt_tokens: Number(usageMeta?.promptTokenCount) || 0,
      completion_tokens: Number(usageMeta?.candidatesTokenCount) || 0,
      total_tokens: Number(usageMeta?.totalTokenCount) || 0,
    },
  }

  return JSON.stringify(openAIResponse)
}

/** 将 Gemini SSE 流式响应转换为 OpenAI SSE 格式 */
async function convertGeminiSSEToOpenAI(readable: ReadableStream, model: string): Promise<ReadableStream> {
  const reader = readable.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()

  return new ReadableStream({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          const chunk = decoder.decode(value, { stream: true })
          const lines = chunk.split('\n')

          for (const line of lines) {
            if (!line.startsWith('data: ')) {
              controller.enqueue(encoder.encode(line + '\n'))
              continue
            }

            const jsonStr = line.substring(6)
            if (jsonStr.trim() === '[DONE]') {
              controller.enqueue(encoder.encode('data: [DONE]\n\n'))
              continue
            }

            try {
              const obj = JSON.parse(jsonStr) as Record<string, unknown>
              const candidates = obj.candidates as Array<Record<string, unknown>>
              const content = candidates?.[0]?.content as Record<string, unknown>
              const parts = content?.parts as Array<Record<string, unknown>>
              const text = parts?.[0]?.text as string || ''
              const finishReason = candidates?.[0]?.finishReason as string

              const openAIChunk = {
                id: `chatcmpl-${Date.now()}`,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [{
                  index: 0,
                  delta: {
                    content: text,
                  },
                  finish_reason: finishReason || null,
                }],
              }

              controller.enqueue(encoder.encode('data: ' + JSON.stringify(openAIChunk) + '\n\n'))
            } catch {
              controller.enqueue(encoder.encode(line + '\n'))
            }
          }
        }
      } catch (e) {
        controller.error(e)
      } finally {
        reader.releaseLock()
        controller.close()
      }
    },
  })
}

interface ProxyKeyCtx {
  ctx: ProxyKeyContext | undefined
}

function getProxyKeyCtx(c: Context<{ Bindings: Env }>): ProxyKeyCtx {
  return { ctx: (c as any).get('proxyKey') as ProxyKeyContext | undefined }
}

/** 处理 /v1/chat/completions、/v1/messages 等 API 转发 */
export async function handleProxy(c: Context<{ Bindings: Env }>) {
  const startTime = Date.now()
  const proxyCtx = getProxyKeyCtx(c)

  let model: string | undefined
  let providerId = ''
  let isStream = false

  /** 统一的客户端错误响应：记录 usage log 后返回 JSON */
  const reject = (status: number, message: string, type: string): Response => {
    const durationMs = Date.now() - startTime
    writeUsageLog(c, proxyCtx.ctx, providerId, model || '', status, durationMs, 0, 0, 0, isStream, `${type}: ${message}`)
    recordProxyOutcome({ providerId, status, durationMs, tokens: 0, stream: isStream })
    return c.json({ error: { message, type } }, status as Parameters<typeof c.json>[1])
  }

  try {
    const body = await c.req.json<ProxyRequestBody>()
    model = body.model
    isStream = !!body.stream

    if (!model) {
      return reject(400, '缺少 model 参数', 'invalid_request_error')
    }

    const parsed = parseModelId(model)
    if (!parsed) {
      return reject(400, `模型格式错误 "${model}"，请使用 提供商ID/模型ID 格式`, 'invalid_request_error')
    }

    const { providerId: pid, modelId } = parsed
    providerId = pid

    // allowedModels 白名单检查
    if (!isModelAllowed(proxyCtx.ctx, model)) {
      return reject(403, `当前 API Key 不允许访问模型 "${model}"`, 'model_forbidden')
    }

    const provider = getProvider(c.env, pid)
    if (!provider) {
      return reject(404, `提供商 "${pid}" 不存在`, 'invalid_request_error')
    }
    if (!provider.enabled) {
      return reject(403, `提供商 "${provider.name}" 已禁用`, 'provider_disabled')
    }

    const modelConfig = provider.models.find((m) => m.id === modelId)
    if (!modelConfig) {
      return reject(404, `模型 "${modelId}" 未在提供商 "${provider.name}" 中配置`, 'invalid_request_error')
    }
    if (!modelConfig.enabled) {
      return reject(403, `模型 "${modelId}" 已禁用`, 'model_disabled')
    }

    const enabledKeys = provider.apiKeys.filter((k) => k.enabled)
    if (enabledKeys.length === 0) {
      return reject(500, `提供商 "${provider.name}" 未配置可用的 API Key`, 'configuration_error')
    }

    let forwardBody: Record<string, unknown> = { ...body, model: modelId }
    let forwardUrl: string
    const url = new URL(c.req.url)
    const cleanBase = provider.baseUrl.replace(/\/$/, '')

    if (provider.apiType === 'google') {
      const conversion = convertOpenAIRequestToGemini(body)
      forwardBody = conversion.payload
      const subPath = url.pathname.replace(/^\/v1\//, '') || 'chat/completions'
      if (subPath === 'chat/completions') {
        const endpoint = isStream ? 'streamGenerateContent' : 'generateContent'
        forwardUrl = `${cleanBase}/models/${modelId}:${endpoint}${url.search}`
      } else {
        forwardUrl = `${cleanBase}/${subPath}${url.search}`
      }
    } else {
      const subPath = url.pathname.replace(/^\/v1\//, '').replace(/\/$/, '') || 'chat/completions'
      forwardUrl = `${cleanBase}/${subPath}${url.search}`
    }

    // 按健康状态分组排序：健康→洗牌，不健康→末尾，冷却到期→试用，连续失败达阈值→降权
    const healthData = readHealth(c.env, pid)
    const healthy: number[] = []
    const unhealthy: number[] = []
    const probation: number[] = []
    const demoted: number[] = []

    if (enabledKeys.length === 1) {
      healthy.push(0)
    } else {
      for (let i = 0; i < enabledKeys.length; i++) {
        const h = healthData[enabledKeys[i].key]
        if (h && h.failures >= KEY_HEALTH_MAX_FAILURES) {
          if (!h.demotedAt) h.demotedAt = Date.now()
          if (Date.now() - h.demotedAt >= KEY_HEALTH_COOLDOWN_MS) {
            probation.push(i)
          } else {
            demoted.push(i)
          }
        } else if (h && h.lastFailed) {
          unhealthy.push(i)
        } else {
          healthy.push(i)
        }
      }
    }

    // Fisher-Yates 洗牌（仅健康 key）
    for (let i = healthy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [healthy[i], healthy[j]] = [healthy[j], healthy[i]]
    }

    const keyOrder = [...healthy, ...unhealthy, ...probation]

    if (keyOrder.length === 0 && demoted.length > 0) {
      keyOrder.push(...demoted)
      console.log(`[proxy] ${pid}: all keys demoted, falling back to ${demoted.length} key(s)`)
    }
    if (demoted.length > 0 || probation.length > 0) {
      console.log(`[proxy] ${pid}: ${demoted.length} key(s) demoted, ${probation.length} key(s) on probation`)
    }

    let lastErrorResponse: Response | null = null
    let lastErrorMessage = ''

    for (const keyIndex of keyOrder) {
      const apiKey = enabledKeys[keyIndex].key
      try {
        const response = await fetch(forwardUrl, {
          method: c.req.method,
          headers: buildUpstreamHeaders(provider, apiKey),
          body: JSON.stringify(forwardBody),
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        })

        if (response.ok) {
          // 成功：重置该 key 健康状态
          if (healthData[apiKey]?.failures > 0) {
            deleteKeyHealth(c.env, pid, apiKey)
          }

          const durationMs = Date.now() - startTime
          const contentType = response.headers.get('Content-Type') || ''
          const isSse = isStream || contentType.includes('text/event-stream')

          if (provider.apiType === 'google') {
            // Google Gemini：需要转换响应格式为 OpenAI 兼容格式
            if (isSse) {
              const convertedStream = await convertGeminiSSEToOpenAI(response.body!, model)
              writeUsageLog(c, proxyCtx.ctx, pid, model, 200, durationMs, 0, 0, 0, true, null)
              recordProxyOutcome({ providerId: pid, status: 200, durationMs, tokens: 0, stream: true })
              return new Response(convertedStream, {
                status: response.status,
                headers: {
                  'Content-Type': 'text/event-stream; charset=utf-8',
                  'Cache-Control': 'no-cache, no-transform',
                  'Connection': 'keep-alive',
                  'X-Accel-Buffering': 'no',
                },
              })
            }

            const text = await response.text()
            let parsedBody: unknown = null
            try { parsedBody = JSON.parse(text) } catch { /* 非 JSON 响应 */ }
            const convertedText = convertGeminiResponseToOpenAI(parsedBody, model)

            let convertedParsed: unknown = null
            try { convertedParsed = JSON.parse(convertedText) } catch { /* ignore */ }
            const usage = extractUsage(convertedParsed, 'openai')

            writeUsageLog(
              c, proxyCtx.ctx, pid, model, response.status, durationMs,
              usage.promptTokens, usage.completionTokens, usage.totalTokens, false, null
            )
            recordProxyOutcome({
              providerId: pid, status: response.status, durationMs,
              tokens: usage.totalTokens, stream: false,
            })
            recordTokens(pid, usage.promptTokens, usage.completionTokens)

            return new Response(convertedText, {
              status: response.status,
              headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-store',
              },
            })
          }

          if (isSse) {
            // 流式响应：直接透传 ReadableStream，不缓冲
            writeUsageLog(c, proxyCtx.ctx, pid, model, 200, durationMs, 0, 0, 0, true, null)
            recordProxyOutcome({ providerId: pid, status: 200, durationMs, tokens: 0, stream: true })
            return new Response(response.body, {
              status: response.status,
              headers: {
                'Content-Type': contentType || 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache, no-transform',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no',
              },
            })
          }

          // 非流式：buffer 后解析 usage，再透传
          const text = await response.text()
          let parsedBody: unknown = null
          try { parsedBody = JSON.parse(text) } catch { /* 非 JSON 响应 */ }
          const usage = extractUsage(parsedBody, provider.apiType)

          writeUsageLog(
            c, proxyCtx.ctx, pid, model, response.status, durationMs,
            usage.promptTokens, usage.completionTokens, usage.totalTokens, false, null
          )
          recordProxyOutcome({
            providerId: pid, status: response.status, durationMs,
            tokens: usage.totalTokens, stream: false,
          })
          recordTokens(pid, usage.promptTokens, usage.completionTokens)

          return new Response(text, {
            status: response.status,
            headers: {
              'Content-Type': contentType || 'application/json',
              'Cache-Control': 'no-store',
            },
          })
        }

        // 429 限流：跳过当前 key，不标记失败
        if (response.status === 429) {
          lastErrorResponse = response
          lastErrorMessage = `HTTP 429`
          continue
        }

        // 401/403/5xx 标记失败并尝试下一个 key
        if (response.status === 401 || response.status === 403 || response.status >= 500) {
          const h: KeyHealth = healthData[apiKey] || { failures: 0, lastFailed: false }
          h.failures++
          h.lastFailed = true
          if (h.failures >= KEY_HEALTH_MAX_FAILURES) {
            h.demotedAt = Date.now()
          }
          healthData[apiKey] = h
          upsertKeyHealth(c.env, pid, apiKey, h)
          lastErrorResponse = response
          lastErrorMessage = `HTTP ${response.status}`
          continue
        }

        // 其他错误（400/404 等）直接返回，不算 key 失败
        const durationMs = Date.now() - startTime
        const errorText = await response.text()
        writeUsageLog(c, proxyCtx.ctx, pid, model, response.status, durationMs, 0, 0, 0, isStream, errorText.substring(0, 500))
        recordProxyOutcome({ providerId: pid, status: response.status, durationMs, tokens: 0, stream: isStream })
        return new Response(errorText, {
          status: response.status,
          headers: { 'Content-Type': response.headers.get('Content-Type') || 'application/json' },
        })
      } catch (err) {
        const error = err as Error
        // 网络错误标记为失败
        const h: KeyHealth = healthData[apiKey] || { failures: 0, lastFailed: false }
        h.failures++
        h.lastFailed = true
        if (h.failures >= KEY_HEALTH_MAX_FAILURES) {
          h.demotedAt = Date.now()
        }
        healthData[apiKey] = h
        upsertKeyHealth(c.env, pid, apiKey, h)
        lastErrorMessage = error.message || '请求失败'
        lastErrorResponse = new Response(JSON.stringify({
          error: { message: lastErrorMessage, type: 'proxy_error' },
        }), { status: 502 })
        continue
      }
    }

    // 所有 key 均失败
    const durationMs = Date.now() - startTime
    let errorBody = '所有 API Key 均失败'
    let statusCode = 502
    if (lastErrorResponse) {
      try { errorBody = await lastErrorResponse.text() } catch { /* ignore */ }
      statusCode = lastErrorResponse.status || 502
    }
    writeUsageLog(
      c, proxyCtx.ctx, pid, model, statusCode, durationMs, 0, 0, 0, isStream,
      `${lastErrorMessage}: ${errorBody.substring(0, 400)}`
    )
    recordProxyOutcome({ providerId: pid, status: statusCode, durationMs, tokens: 0, stream: isStream })

    return c.json({
      error: {
        message: `所有 API Key 已用完，最后一次错误: ${lastErrorMessage || 'HTTP ' + statusCode}`,
        type: 'key_exhausted',
        detail: errorBody.substring(0, 500),
      },
    }, statusCode as Parameters<typeof c.json>[1])
  } catch (err) {
    const error = err as Error
    const durationMs = Date.now() - startTime
    writeUsageLog(c, proxyCtx.ctx, providerId, model || '', 500, durationMs, 0, 0, 0, isStream, error.message || '代理转发内部错误')
    recordProxyOutcome({ providerId: providerId, status: 500, durationMs, tokens: 0, stream: isStream })
    return c.json({
      error: { message: error.message || '代理转发内部错误', type: 'server_error' },
    }, 500)
  }
}

/** 写入用量日志（同步、轻量） */
function writeUsageLog(
  c: Context<{ Bindings: Env }>,
  ctx: ProxyKeyContext | undefined,
  providerId: string,
  model: string,
  status: number,
  durationMs: number,
  promptTokens: number,
  completionTokens: number,
  totalTokens: number,
  stream: boolean,
  error: string | null
): void {
  try {
    insertUsageLog(c.env, {
      proxyKeyId: ctx?.id || 'unknown',
      proxyKeyName: ctx?.name || 'unknown',
      providerId,
      model,
      status,
      durationMs,
      promptTokens,
      completionTokens,
      totalTokens,
      stream,
      error,
    })
  } catch (e) {
    console.error('[usage] 写入用量日志失败:', e)
  }
}

/** 处理 /v1/models — 返回所有已启用的模型（含提供商前缀） */
export function handleModels(c: Context<{ Bindings: Env }>) {
  const providers = getProviders(c.env)

  const models: Array<{
    id: string
    provider: string
    provider_name: string
    object: string
    created: number
    owned_by: string
  }> = []

  for (const provider of providers) {
    if (!provider.enabled) continue
    for (const model of provider.models) {
      if (!model.enabled) continue
      models.push({
        id: `${provider.id}/${model.id}`,
        provider: provider.id,
        provider_name: provider.name,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: provider.id,
      })
    }
  }

  return c.json({
    object: 'list',
    data: models,
  })
}
