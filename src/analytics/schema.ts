import type Database from "better-sqlite3";

export function initAnalyticsSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_name TEXT NOT NULL,
      source_id TEXT,
      auth_level TEXT,
      status TEXT NOT NULL,
      duration_ms INTEGER,
      request_size INTEGER,
      response_size INTEGER,
      token_estimate INTEGER,
      error_message TEXT,
      called_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_tool_calls_called_at ON tool_calls(called_at);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_tool_name ON tool_calls(tool_name);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_source_id ON tool_calls(source_id);

    CREATE TABLE IF NOT EXISTS adapter_health (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      adapter_id TEXT NOT NULL,
      status TEXT NOT NULL,
      init_duration_ms INTEGER,
      tool_count INTEGER,
      resource_count INTEGER,
      error_message TEXT,
      checked_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_adapter_health_checked_at ON adapter_health(checked_at);
    CREATE INDEX IF NOT EXISTS idx_adapter_health_adapter_id ON adapter_health(adapter_id);
  `);
}
