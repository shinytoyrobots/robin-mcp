import crypto from "crypto";
import type { Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { getDb } from "../db.js";
import { config } from "../config.js";

const CODE_TTL_SEC = 600;            // 10 minutes
const ACCESS_TOKEN_TTL_SEC = 3600;   // 1 hour
const REFRESH_TOKEN_TTL_SEC = 30 * 24 * 3600; // 30 days

// ---------------------------------------------------------------------------
// Clients store (DCR)
// ---------------------------------------------------------------------------

class OAuthClientsStore implements OAuthRegisteredClientsStore {
  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const db = getDb();
    const row = db
      .prepare("SELECT metadata_json FROM mcp_oauth_clients WHERE client_id = ?")
      .get(clientId) as { metadata_json: string } | undefined;
    if (!row) return undefined;
    return JSON.parse(row.metadata_json);
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): OAuthClientInformationFull {
    const db = getDb();
    const clientId = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);

    const full: OAuthClientInformationFull = {
      ...client,
      client_id: clientId,
      client_id_issued_at: now,
    } as OAuthClientInformationFull;

    db.prepare(
      "INSERT INTO mcp_oauth_clients (client_id, client_secret, client_secret_expires_at, client_id_issued_at, metadata_json) VALUES (?, ?, ?, ?, ?)",
    ).run(
      clientId,
      full.client_secret ?? null,
      full.client_secret_expires_at ?? 0,
      now,
      JSON.stringify(full),
    );

    return full;
  }
}

// ---------------------------------------------------------------------------
// OAuth server provider
// ---------------------------------------------------------------------------

export class RobinOAuthProvider implements OAuthServerProvider {
  private _clientsStore = new OAuthClientsStore();

  get clientsStore(): OAuthRegisteredClientsStore {
    return this._clientsStore;
  }

  // -- Authorization --------------------------------------------------------

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const cfEmail = (res.locals.cfEmail as string | undefined)?.toLowerCase();

    // In production CF Access sets the email header on /authorize.
    // In local dev (no issuer URL configured) auto-grant to admin email.
    const email = cfEmail || (!config.oauthIssuerUrl ? config.adminEmail.toLowerCase() : undefined);

    if (!email || !config.allowedEmails.includes(email)) {
      const errorUrl = new URL(params.redirectUri);
      errorUrl.searchParams.set("error", "access_denied");
      errorUrl.searchParams.set("error_description", "Email not authorized");
      if (params.state) errorUrl.searchParams.set("state", params.state);
      res.redirect(errorUrl.toString());
      return;
    }

    // Admin email gets requested scopes (default mcp:full); others get read-only.
    const requested = params.scopes || [];
    const grantedScopes =
      email === config.adminEmail.toLowerCase()
        ? requested.length > 0 ? requested : ["mcp:full"]
        : ["mcp:read"];

    const code = crypto.randomBytes(32).toString("hex");
    const now = Math.floor(Date.now() / 1000);

    const db = getDb();
    db.prepare(
      `INSERT INTO mcp_oauth_codes
       (code, client_id, redirect_uri, code_challenge, scopes, state, email, resource, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      code,
      client.client_id,
      params.redirectUri,
      params.codeChallenge,
      grantedScopes.join(" "),
      params.state ?? null,
      email,
      params.resource?.toString() ?? null,
      now + CODE_TTL_SEC,
    );

    const redirectUrl = new URL(params.redirectUri);
    redirectUrl.searchParams.set("code", code);
    if (params.state) redirectUrl.searchParams.set("state", params.state);
    res.redirect(redirectUrl.toString());
  }

  // -- PKCE challenge lookup ------------------------------------------------

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    const row = db
      .prepare(
        "SELECT code_challenge FROM mcp_oauth_codes WHERE code = ? AND client_id = ? AND consumed = 0 AND expires_at > ?",
      )
      .get(authorizationCode, client.client_id, now) as { code_challenge: string } | undefined;

    if (!row) throw new Error("Invalid or expired authorization code");
    return row.code_challenge;
  }

  // -- Code → token exchange ------------------------------------------------

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);

    const row = db
      .prepare(
        "SELECT * FROM mcp_oauth_codes WHERE code = ? AND client_id = ? AND consumed = 0 AND expires_at > ?",
      )
      .get(authorizationCode, client.client_id, now) as Record<string, unknown> | undefined;

    if (!row) throw new Error("Invalid or expired authorization code");
    if (redirectUri && row.redirect_uri !== redirectUri) throw new Error("Redirect URI mismatch");

    // Mark consumed
    db.prepare("UPDATE mcp_oauth_codes SET consumed = 1 WHERE code = ?").run(authorizationCode);

    return this._issueTokenPair(
      client.client_id,
      row.scopes as string,
      row.email as string,
      resource?.toString() ?? (row.resource as string | null),
    );
  }

  // -- Refresh token exchange -----------------------------------------------

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);

    const row = db
      .prepare(
        "SELECT * FROM mcp_oauth_tokens WHERE token = ? AND token_type = 'refresh' AND client_id = ? AND revoked = 0 AND expires_at > ?",
      )
      .get(refreshToken, client.client_id, now) as Record<string, unknown> | undefined;

    if (!row) throw new Error("Invalid or expired refresh token");

    // Revoke old pair
    db.prepare("UPDATE mcp_oauth_tokens SET revoked = 1 WHERE token = ? OR token = ?").run(
      refreshToken,
      row.linked_token as string,
    );

    const grantedScopes = scopes ? scopes.join(" ") : (row.scopes as string);
    return this._issueTokenPair(
      client.client_id,
      grantedScopes,
      row.email as string,
      resource?.toString() ?? (row.resource as string | null),
    );
  }

  // -- Token verification ---------------------------------------------------

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);

    const row = db
      .prepare(
        "SELECT client_id, scopes, resource, expires_at FROM mcp_oauth_tokens WHERE token = ? AND token_type = 'access' AND revoked = 0 AND expires_at > ?",
      )
      .get(token, now) as
      | { client_id: string; scopes: string; resource: string | null; expires_at: number }
      | undefined;

    if (!row) throw new Error("Invalid or expired access token");

    return {
      token,
      clientId: row.client_id,
      scopes: row.scopes ? row.scopes.split(" ") : [],
      expiresAt: row.expires_at,
      ...(row.resource ? { resource: new URL(row.resource) } : {}),
    };
  }

  // -- Token revocation -----------------------------------------------------

  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    const db = getDb();
    const row = db
      .prepare("SELECT token, linked_token FROM mcp_oauth_tokens WHERE token = ? AND client_id = ?")
      .get(request.token, client.client_id) as
      | { token: string; linked_token: string | null }
      | undefined;

    if (row) {
      if (row.linked_token) {
        db.prepare("UPDATE mcp_oauth_tokens SET revoked = 1 WHERE token = ? OR token = ?").run(
          row.token,
          row.linked_token,
        );
      } else {
        db.prepare("UPDATE mcp_oauth_tokens SET revoked = 1 WHERE token = ?").run(row.token);
      }
    }
  }

  // -- Internal helpers -----------------------------------------------------

  private _issueTokenPair(
    clientId: string,
    scopes: string,
    email: string,
    resource: string | null,
  ): OAuthTokens {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);

    const accessToken = crypto.randomBytes(48).toString("hex");
    const refreshToken = crypto.randomBytes(48).toString("hex");

    db.prepare(
      `INSERT INTO mcp_oauth_tokens
       (token, token_type, client_id, scopes, email, resource, linked_token, expires_at)
       VALUES (?, 'access', ?, ?, ?, ?, ?, ?)`,
    ).run(accessToken, clientId, scopes, email, resource, refreshToken, now + ACCESS_TOKEN_TTL_SEC);

    db.prepare(
      `INSERT INTO mcp_oauth_tokens
       (token, token_type, client_id, scopes, email, resource, linked_token, expires_at)
       VALUES (?, 'refresh', ?, ?, ?, ?, ?, ?)`,
    ).run(refreshToken, clientId, scopes, email, resource, accessToken, now + REFRESH_TOKEN_TTL_SEC);

    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SEC,
      scope: scopes,
      refresh_token: refreshToken,
    };
  }
}
