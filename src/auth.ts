import { Context, Next } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { createSession, getSession, deleteSession, validateProxyKey, incrementRateCounter } from './storage'
import { SESSION_TTL, RPM_WINDOW_MS } from './config'
import { recordRateLimitHit } from './metrics'
import type { Env, ProxyKeyContext } from './types'

/** SHA-256 哈希 */
export async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(password)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** 管理后台 Session 验证中间件 */
export async function adminAuthMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  const sessionId = getCookie(c, 'session_id')

  if (!sessionId) {
    const url = new URL(c.req.url)
    if (url.pathname === '/admin/login') return next()
    if (url.pathname.startsWith('/admin/api/')) {
      return c.json({ success: false, message: '未登录' }, 401)
    }
    return c.redirect('/admin/login')
  }

  const session = getSession(c.env, sessionId)
  if (!session) {
    deleteCookie(c, 'session_id')
    const url = new URL(c.req.url)
    if (url.pathname.startsWith('/admin/api/')) {
      return c.json({ success: false, message: 'Session 已过期' }, 401)
    }
    return c.redirect('/admin/login')
  }

  ;(c as any).set('username', session.username)
  return next()
}

/** 管理员登录 */
export async function handleLogin(c: Context<{ Bindings: Env }>) {
  const { username, password } = await c.req.json()
  const adminUser = c.env.ADMIN_USERNAME
  const adminPass = c.env.ADMIN_PASSWORD

  if (!adminUser || !adminPass) {
    return c.json({
      success: false,
      message: '未配置管理员账号，请在环境变量中设置 ADMIN_USERNAME 和 ADMIN_PASSWORD',
    }, 500)
  }

  if (!username || !password) {
    return c.json({ success: false, message: '请输入用户名和密码' }, 400)
  }

  if (username !== adminUser) {
    return c.json({ success: false, message: '用户名或密码错误' }, 401)
  }

  const passwordHash = await hashPassword(password)
  const adminPassHash = await hashPassword(adminPass)

  if (passwordHash !== adminPassHash) {
    return c.json({ success: false, message: '用户名或密码错误' }, 401)
  }

  const sessionId = createSession(c.env, username, SESSION_TTL)
  setCookie(c, 'session_id', sessionId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL,
  })

  return c.json({ success: true, message: '登录成功' })
}

/** 退出登录 */
export async function handleLogout(c: Context<{ Bindings: Env }>) {
  const sessionId = getCookie(c, 'session_id')
  if (sessionId) {
    deleteSession(c.env, sessionId)
    deleteCookie(c, 'session_id')
  }
  return c.redirect('/')
}

/** 计算当前时间所属的窗口起点（毫秒） */
function windowStart(now: number, windowMs: number): number {
  return Math.floor(now / windowMs) * windowMs
}

/**
 * 转发 API Key 验证 + RPM / 日配额限流中间件。
 * 验证通过后把 ProxyKeyContext 挂到 c.var.proxyKey，供 proxy.ts 使用。
 */
export async function proxyKeyAuthMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  const authHeader = c.req.header('Authorization')
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({
      error: { message: '缺少或无效的 Authorization 头，格式: Bearer sk_cf_*', type: 'authentication_error' },
    }, 401)
  }

  const token = authHeader.slice(7)
  const proxyKey = validateProxyKey(c.env, token)
  if (!proxyKey) {
    return c.json({
      error: { message: 'API Key 无效或已禁用', type: 'authentication_error' },
    }, 401)
  }

  // RPM 与日配额原子递增并检查
  const now = Date.now()
  const rpmStart = windowStart(now, RPM_WINDOW_MS)
  const dailyStart = windowStart(now, 24 * 60 * 60 * 1000)
  const { rpmCount, dailyCount } = incrementRateCounter(c.env, proxyKey.id, rpmStart, dailyStart)

  if (proxyKey.rpm > 0 && rpmCount > proxyKey.rpm) {
    recordRateLimitHit('rpm')
    return c.json({
      error: {
        message: `请求过于频繁：当前 RPM ${rpmCount} 已超过限制 ${proxyKey.rpm}/min`,
        type: 'rate_limit_error',
      },
    }, 429)
  }
  if (proxyKey.dailyQuota > 0 && dailyCount > proxyKey.dailyQuota) {
    recordRateLimitHit('daily')
    return c.json({
      error: {
        message: `今日请求次数 ${dailyCount} 已超过配额 ${proxyKey.dailyQuota}/天`,
        type: 'quota_exceeded',
      },
    }, 429)
  }

  const ctx: ProxyKeyContext = {
    id: proxyKey.id,
    name: proxyKey.name,
    rpm: proxyKey.rpm,
    dailyQuota: proxyKey.dailyQuota,
    allowedModels: proxyKey.allowedModels,
  }
  ;(c as any).set('proxyKey', ctx)
  return next()
}

/** 检查 model 是否在 ProxyKey 的 allowedModels 白名单内 */
export function isModelAllowed(ctx: ProxyKeyContext | undefined, fullModelId: string): boolean {
  if (!ctx || ctx.allowedModels.length === 0) return true
  return ctx.allowedModels.some((prefix) => fullModelId === prefix || fullModelId.startsWith(prefix + '/') || fullModelId.startsWith(prefix))
}
