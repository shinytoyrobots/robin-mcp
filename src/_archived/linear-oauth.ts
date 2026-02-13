import { getDb } from "../db.js";
import { config } from "../config.js";

const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";
const LINEAR_REVOKE_URL = "https://api.linear.app/oauth/revoke";
const EXPIRY_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

interface OAuthTokenRow {
  provider: string;
  access_token: string;
  refresh_token: string;
  token_type: string;
  scope: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

interface LinearTokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  scope: string;
  expires_in: number;
}

/**
 * Returns a valid Linear access token, refreshing if needed.
 * Returns null if no token is available.
 */
export async function getLinearAccessToken(): Promise<string | null> {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM oauth_tokens WHERE provider = 'linear'")
    .get() as OAuthTokenRow | undefined;

  if (!row) return null;

  const expiresAt = new Date(row.expires_at + "Z").getTime();
  const now = Date.now();

  if (now < expiresAt - EXPIRY_BUFFER_MS) {
    return row.access_token;
  }

  // Token expired or about to expire — refresh
  try {
    return await refreshAccessToken(row);
  } catch (err) {
    console.error("[linear-oauth] Refresh failed, clearing stored token:", err);
    db.prepare("DELETE FROM oauth_tokens WHERE provider = 'linear'").run();
    return null;
  }
}

/**
 * Exchange an authorization code for tokens and store them.
 */
export async function exchangeCodeForToken(
  code: string,
  redirectUri: string
): Promise<void> {
  const response = await fetch(LINEAR_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: config.linearClientId,
      client_secret: config.linearClientSecret,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Token exchange failed: ${response.status} ${body}`);
  }

  const data = (await response.json()) as LinearTokenResponse;
  storeToken(data);
}

/**
 * Refresh the access token using the stored refresh token.
 * Linear uses token rotation — always stores the latest refresh token.
 */
async function refreshAccessToken(row: OAuthTokenRow): Promise<string> {
  const response = await fetch(LINEAR_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: row.refresh_token,
      client_id: config.linearClientId,
      client_secret: config.linearClientSecret,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Token refresh failed: ${response.status} ${body}`);
  }

  const data = (await response.json()) as LinearTokenResponse;
  storeToken(data);
  console.error("[linear-oauth] Token refreshed successfully");
  return data.access_token;
}

/**
 * Persist token data to SQLite.
 */
function storeToken(data: LinearTokenResponse): void {
  const db = getDb();
  const expiresAt = new Date(Date.now() + data.expires_in * 1000)
    .toISOString()
    .replace("Z", "")
    .replace("T", " ")
    .slice(0, 19);

  db.prepare(`
    INSERT INTO oauth_tokens (provider, access_token, refresh_token, token_type, scope, expires_at)
    VALUES ('linear', ?, ?, ?, ?, ?)
    ON CONFLICT(provider) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      token_type = excluded.token_type,
      scope = excluded.scope,
      expires_at = excluded.expires_at,
      updated_at = datetime('now')
  `).run(
    data.access_token,
    data.refresh_token,
    data.token_type || "Bearer",
    data.scope || "",
    expiresAt
  );
}

/**
 * Revoke the stored Linear token and delete from DB.
 */
export async function revokeLinearToken(): Promise<void> {
  const db = getDb();
  const row = db
    .prepare("SELECT access_token FROM oauth_tokens WHERE provider = 'linear'")
    .get() as { access_token: string } | undefined;

  db.prepare("DELETE FROM oauth_tokens WHERE provider = 'linear'").run();

  if (row) {
    // Fire-and-forget revocation at Linear
    fetch(LINEAR_REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: row.access_token }),
    }).catch((err) => {
      console.error("[linear-oauth] Revocation request failed (non-fatal):", err);
    });
  }
}

/**
 * Get the current OAuth connection status.
 */
export function getLinearOAuthStatus(): {
  connected: boolean;
  expiresAt?: string;
  scope?: string;
  updatedAt?: string;
} {
  const db = getDb();
  const row = db
    .prepare("SELECT expires_at, scope, updated_at FROM oauth_tokens WHERE provider = 'linear'")
    .get() as Pick<OAuthTokenRow, "expires_at" | "scope" | "updated_at"> | undefined;

  if (!row) return { connected: false };

  return {
    connected: true,
    expiresAt: row.expires_at,
    scope: row.scope,
    updatedAt: row.updated_at,
  };
}

/**
 * Clear stored Linear token (used when API returns 401).
 */
export function clearLinearToken(): void {
  const db = getDb();
  db.prepare("DELETE FROM oauth_tokens WHERE provider = 'linear'").run();
}
