import Database from 'better-sqlite3'
import { promises as fs } from 'node:fs'
import path from 'node:path'

/** better-sqlite3 数据库实例类型 */
export type DB = Database.Database

/**
 * 打开并初始化 SQLite 数据库。
 * - 启用 WAL 提升并发读
 * - 启用 foreign_keys
 * - 应用 schema 迁移（幂等）
 */
export async function openDatabase(dbPath: string): Promise<DB> {
  // 确保目录存在
  await fs.mkdir(path.dirname(dbPath), { recursive: true })

  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')

  applyMigrations(db)
  return db
}

/** 应用 schema。所有 CREATE 语句均使用 IF NOT EXISTS，可重复执行。 */
function applyMigrations(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS providers (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      base_url    TEXT NOT NULL,
      api_type    TEXT NOT NULL DEFAULT 'openai',
      api_keys    TEXT NOT NULL DEFAULT '[]',
      models      TEXT NOT NULL DEFAULT '[]',
      enabled     INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      session_id  TEXT PRIMARY KEY,
      username    TEXT NOT NULL,
      expires_at  INTEGER NOT NULL,
      created_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS proxy_keys (
      id              TEXT PRIMARY KEY,
      key             TEXT NOT NULL UNIQUE,
      name            TEXT NOT NULL,
      enabled         INTEGER NOT NULL DEFAULT 1,
      created_at      TEXT NOT NULL,
      expires_at      TEXT,
      rpm             INTEGER NOT NULL DEFAULT 0,
      daily_quota     INTEGER NOT NULL DEFAULT 0,
      allowed_models  TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS key_health (
      provider_id   TEXT NOT NULL,
      api_key       TEXT NOT NULL,
      failures      INTEGER NOT NULL DEFAULT 0,
      last_failed   INTEGER NOT NULL DEFAULT 0,
      demoted_at    INTEGER,
      PRIMARY KEY (provider_id, api_key)
    );

    CREATE TABLE IF NOT EXISTS usage_logs (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      proxy_key_id        TEXT NOT NULL,
      proxy_key_name      TEXT NOT NULL,
      provider_id         TEXT NOT NULL,
      model               TEXT NOT NULL,
      status              INTEGER NOT NULL,
      duration_ms         INTEGER NOT NULL DEFAULT 0,
      prompt_tokens       INTEGER NOT NULL DEFAULT 0,
      completion_tokens   INTEGER NOT NULL DEFAULT 0,
      total_tokens        INTEGER NOT NULL DEFAULT 0,
      stream              INTEGER NOT NULL DEFAULT 0,
      error               TEXT,
      created_at          TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_usage_created   ON usage_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_usage_key       ON usage_logs(proxy_key_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_usage_provider  ON usage_logs(provider_id, created_at);

    CREATE TABLE IF NOT EXISTS rate_counters (
      key_id        TEXT NOT NULL,
      window_start  INTEGER NOT NULL,
      count         INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (key_id, window_start)
    );
  `)

  // 一次性自愈：修正已知错误的默认值（例如 Gemini 的 OpenAI 兼容端点应为 /v1beta 而非 /v1）
  healProviderConfig(db)
}

/**
 * 自愈已部署实例中已知的错误配置。
 * 仅对「明确错误」的旧值做修正，避免覆盖用户的自定义 base_url。
 */
function healProviderConfig(db: DB): void {
  const BAD_GEMINI = 'https://generativelanguage.googleapis.com/v1'
  const GOOD_GEMINI = 'https://generativelanguage.googleapis.com/v1beta'
  const r = db.prepare(
    "UPDATE providers SET base_url = ?, updated_at = ? WHERE id = 'gemini' AND base_url = ?"
  ).run(GOOD_GEMINI, new Date().toISOString(), BAD_GEMINI)
  if (r.changes > 0) {
    console.log('[migrate] corrected gemini base_url ->', GOOD_GEMINI)
  }
}
