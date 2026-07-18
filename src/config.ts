import type { Provider } from './types'

export const SITE_CONFIG = {
  title: 'AI Gateway',
  subtitle: '统一的 AI 管理平台',
  author: 'QingYun',
  authorUrl: 'https://github.com/yutian81/ai-gateway',
  blogUrl: 'https://blog.notett.com',
  description: 'AI 提供商 API 代理网关 — 统一 /v1 接口转发',
  favicon: 'https://pan.811520.xyz/icon/ai.webp',
  faCdn: 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.7.2/css/all.min.css',
}

/** 管理后台 Session 有效期（秒） */
export const SESSION_TTL = 7 * 24 * 60 * 60

/** 转发 Key 前缀 */
export const PROXY_KEY_PREFIX = 'sk_cf_'

/** Key 降权后自动恢复的冷却时间 (毫秒) */
export const KEY_HEALTH_COOLDOWN_MS = 5 * 60 * 1000

/** 连续失败多少次后降权 */
export const KEY_HEALTH_MAX_FAILURES = 5

/** 上游请求超时（毫秒） */
export const UPSTREAM_TIMEOUT_MS = 60_000

/** 转发 Key 临时冷却 / 限流计数窗口（毫秒） */
export const RPM_WINDOW_MS = 60_000

/** SQLite 数据库文件路径（可用环境变量 DB_PATH 覆盖） */
export const DB_PATH = process.env.DB_PATH || './data/ai-gateway.db'

/** HTTP 监听端口 */
export const PORT = Number(process.env.PORT) || 8787

/** 转发 Key 有效期选项（秒），null 表示永久 */
export const EXPIRY_OPTIONS: Record<string, number | null> = {
  '30d': 30 * 24 * 60 * 60,
  '90d': 90 * 24 * 60 * 60,
  '180d': 180 * 24 * 60 * 60,
  '1y': 365 * 24 * 60 * 60,
  'forever': null,
}

/** 用量日志保留天数（超出后自动清理） */
export const USAGE_LOG_RETENTION_DAYS = Number(process.env.USAGE_LOG_RETENTION_DAYS) || 90

export const DEFAULT_PROVIDERS: Provider[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    apiType: 'openai',
    apiKeys: [],
    models: [
      { id: 'deepseek-chat', enabled: true },
      { id: 'deepseek-reasoner', enabled: true },
    ],
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    apiType: 'openai',
    apiKeys: [],
    models: [
      { id: 'gpt-4o', enabled: true },
      { id: 'gpt-4o-mini', enabled: true },
      { id: 'gpt-4.1', enabled: true },
      { id: 'o4-mini', enabled: true },
    ],
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    apiType: 'anthropic',
    apiKeys: [],
    models: [
      { id: 'claude-opus-4-20250514', enabled: true },
      { id: 'claude-sonnet-4-20250514', enabled: true },
      { id: 'claude-3-5-haiku-20241022', enabled: true },
    ],
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'gemini',
    name: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiType: 'google',
    apiKeys: [],
    models: [
      { id: 'gemini-2.5-flash', enabled: true },
      { id: 'gemini-2.5-pro', enabled: true },
      { id: 'gemini-2.0-flash', enabled: true },
    ],
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
]
