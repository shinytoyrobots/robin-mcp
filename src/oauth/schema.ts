import type Database from "better-sqlite3";

export function initOAuthSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
      client_id TEXT PRIMARY KEY,
      client_secret TEXT,
      client_secret_expires_at INTEGER DEFAULT 0,
      client_id_issued_at INTEGER NOT NULL,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS mcp_oauth_codes (
      code TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      code_challenge TEXT NOT NULL,
      scopes TEXT NOT NULL DEFAULT '',
      state TEXT,
      email TEXT NOT NULL,
      resource TEXT,
      expires_at INTEGER NOT NULL,
      consumed INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_mcp_oauth_codes_expires
      ON mcp_oauth_codes(expires_at);

    CREATE TABLE IF NOT EXISTS mcp_oauth_tokens (
      token TEXT PRIMARY KEY,
      token_type TEXT NOT NULL,
      client_id TEXT NOT NULL,
      scopes TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL,
      resource TEXT,
      linked_token TEXT,
      expires_at INTEGER NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_mcp_oauth_tokens_expires
      ON mcp_oauth_tokens(expires_at);
  `);
}

/** Remove expired codes and revoked/expired tokens. */
export function pruneExpiredOAuthData(db: Database.Database): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare("DELETE FROM mcp_oauth_codes WHERE expires_at < ? OR consumed = 1").run(now);
  // Keep revoked tokens for 24h so linked-token revocation propagates
  db.prepare("DELETE FROM mcp_oauth_tokens WHERE (expires_at < ? AND revoked = 0) OR (revoked = 1 AND expires_at < ?)").run(now, now - 86400);
}
