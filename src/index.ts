import 'dotenv/config'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { serve } from '@hono/node-server'
import { getCookie } from 'hono/cookie'
import type { Env } from './types'
import { openDatabase } from './db'
import { DB_PATH, PORT, USAGE_LOG_RETENTION_DAYS } from './config'
import { adminAuthMiddleware, proxyKeyAuthMiddleware, handleLogin, handleLogout } from './auth'
import { handleProxy, handleModels } from './proxy'
import {
  handleStatus,
  handleGetProviders,
  handleCreateProvider,
  handleUpdateProvider,
  handleDeleteProvider,
  handleTestModel,
  handleTestKeyNew,
  handleTestModelNew,
  handleGetProxyKeys,
  handleCreateProxyKey,
  handleUpdateProxyKey,
  handleDeleteProxyKey,
  handleUsageSummary,
  handleUsageLogs,
} from './admin'
import { renderHomePage, renderLoginPage, renderAdminPage } from './pages'
import {
  seedInitialData,
  getSession,
  purgeRateCounters,
  purgeUsageLogs,
} from './storage'
import { handleMetrics } from './metrics'

async function main() {
  const db = await openDatabase(DB_PATH)

  const env: Env = {
    db,
    ADMIN_USERNAME: process.env.ADMIN_USERNAME,
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
  }

  // 首次启动填充默认数据（providers + 一个测试 Key）
  seedInitialData(env)

  const app = new Hono<{ Bindings: Env }>()

  // ===== 全局中间件 =====
  app.use('*', cors())
  app.use('*', logger())

  // ===== 首页 =====
  app.get('/', (c) => {
    const sessionId = getCookie(c, 'session_id')
    let isLoggedIn = false
    if (sessionId) {
      const session = getSession(c.env, sessionId)
      isLoggedIn = session !== null
    }
    return renderHomePage(c, isLoggedIn)
  })

  // ===== 登录/退出 =====
  app.get('/admin/login', (c) => renderLoginPage(c))
  app.post('/admin/login', handleLogin)
  app.get('/admin/logout', handleLogout)

  // ===== Prometheus 指标（可选 Bearer Token 鉴权） =====
  app.get('/metrics', handleMetrics)

  // ===== 管理后台（需 Session 验证） =====
  app.use('/admin/*', adminAuthMiddleware)

  app.get('/admin', (c) => renderAdminPage(c))

  // 系统状态
  app.get('/admin/api/status', handleStatus)

  // 提供商 CRUD
  app.get('/admin/api/providers', handleGetProviders)
  app.post('/admin/api/providers', handleCreateProvider)
  app.put('/admin/api/providers/:id', handleUpdateProvider)
  app.delete('/admin/api/providers/:id', handleDeleteProvider)
  app.post('/admin/api/providers/:id/test-model', handleTestModel)
  app.post('/admin/api/test-key', handleTestKeyNew)
  app.post('/admin/api/test-model', handleTestModelNew)

  // 转发 Key 管理
  app.get('/admin/api/proxy-keys', handleGetProxyKeys)
  app.post('/admin/api/proxy-keys', handleCreateProxyKey)
  app.delete('/admin/api/proxy-keys/:id', handleDeleteProxyKey)
  app.patch('/admin/api/proxy-keys/:id', handleUpdateProxyKey)

  // 用量统计
  app.get('/admin/api/usage/summary', handleUsageSummary)
  app.get('/admin/api/usage/logs', handleUsageLogs)

  // ===== API 转发路由（需转发 Key 验证） =====
  app.use('/v1/*', proxyKeyAuthMiddleware)
  app.get('/v1/models', handleModels)
  app.all('/v1/*', handleProxy)

  // ===== 404 处理 =====
  app.notFound((c) => {
    return c.json({ error: { message: '接口不存在', type: 'not_found' } }, 404)
  })

  // ===== 错误处理 =====
  app.onError((err, c) => {
    console.error('未捕获的错误:', err)
    return c.json({ error: { message: '服务器内部错误', type: 'server_error' } }, 500)
  })

  // ===== 定期清理任务 =====
  const HOUR_MS = 60 * 60 * 1000
  setInterval(() => {
    try {
      // 清理 2 天前的限流计数器
      const twoDaysAgoMs = Date.now() - 2 * 24 * HOUR_MS
      purgeRateCounters(env, twoDaysAgoMs)
      // 清理超期用量日志
      const cutoff = new Date(Date.now() - USAGE_LOG_RETENTION_DAYS * 24 * HOUR_MS).toISOString()
      purgeUsageLogs(env, cutoff)
    } catch (e) {
      console.error('[cleanup] 定期清理任务出错:', e)
    }
  }, HOUR_MS)

  serve(
    {
      fetch: (req) => app.fetch(req, env),
      port: PORT,
      hostname: '0.0.0.0',
    },
    (info) => {
      console.log(`[ai-gateway] listening on http://0.0.0.0:${info.port}`)
      console.log(`[ai-gateway] database: ${DB_PATH}`)
      if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD) {
        console.warn('[ai-gateway] ⚠ 未配置 ADMIN_USERNAME / ADMIN_PASSWORD，管理后台无法登录')
      }
    }
  )
}

main().catch((err) => {
  console.error('启动失败:', err)
  process.exit(1)
})
