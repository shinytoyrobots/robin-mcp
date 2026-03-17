import express from "express";
import crypto from "crypto";
import compression from "compression";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { createServer } from "./server.js";
import { config } from "./config.js";
import { createDashboardRouter } from "./dashboard/router.js";
import { pruneOldAnalytics } from "./analytics/tracker.js";
import { pruneExpiredOAuthData } from "./oauth/schema.js";
import { getDb } from "./db.js";
import { RobinOAuthProvider } from "./oauth/provider.js";
import { createGcalRouter, scheduleCalendarRefresh } from "./routes/gcal.js";
const app = express();
// Skip compression for MCP endpoint — compression buffers SSE chunks,
// delaying event delivery and causing clients to think the connection dropped.
app.use((req, res, next) => {
  if (req.path === "/mcp") return next();
  compression()(req, res, next);
});
app.use(express.json());

// Landing page for browser visitors
app.get("/", (_req, res) => {
  res.type("html").send(`<!DOCTYPE html>
<html><head><title>Robin MCP</title>
<style>body{font-family:system-ui,sans-serif;max-width:600px;margin:60px auto;padding:0 20px;color:#333}
h1{font-size:1.5rem}code{background:#f0f0f0;padding:2px 6px;border-radius:3px;font-size:0.9em}
li{margin:8px 0}.muted{color:#888;font-size:0.85rem}</style></head>
<body>
<h1>Robin MCP Server</h1>
<p>A personal <a href="https://modelcontextprotocol.io">Model Context Protocol</a> server with tools for notes, bookmarks, GitHub repos, and creative writing resources.</p>
<h3>Connect</h3>
<ul>
<li><strong>MCP endpoint:</strong> <code>/mcp</code></li>
<li><strong>Claude Code:</strong> <code>claude mcp add --transport http robin-mcp [url]/mcp</code></li>
<li><strong>ChatGPT:</strong> Add as a connector in Developer Mode</li>
</ul>
<p class="muted">Built by Robin Cannon</p>
</body></html>`);
});

// ---------------------------------------------------------------------------
// OAuth 2.1 setup
// ---------------------------------------------------------------------------

const issuerUrl = new URL(
  config.oauthIssuerUrl || `http://localhost:${config.httpPort}`,
);
const resourceServerUrl = new URL("/mcp", issuerUrl);
const oauthProvider = new RobinOAuthProvider();

// Inject CF Access email into res.locals before the authorize handler
app.use("/authorize", (req, res, next) => {
  const cfEmail = (
    req.headers["cf-access-authenticated-user-email"] as string | undefined
  )?.toLowerCase();
  if (cfEmail) res.locals.cfEmail = cfEmail;
  next();
});

// Mount OAuth endpoints: /authorize, /token, /register, /revoke, /.well-known/*
app.use(
  mcpAuthRouter({
    provider: oauthProvider,
    issuerUrl,
    scopesSupported: ["mcp:full", "mcp:read"],
    resourceServerUrl,
    resourceName: "Robin MCP",
  }),
);

// Bearer auth middleware for OAuth tokens on /mcp
const oauthBearerAuth = requireBearerAuth({
  verifier: oauthProvider,
  resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
});

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

declare global {
  namespace Express {
    interface Request {
      readOnly?: boolean;
      cfEmail?: string;
    }
  }
}

/**
 * Legacy token auth for /gcal and backward compat.
 * Checks query token, bearer token, and CF Access email allowlist.
 */
function legacyAuthMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  const queryToken = req.query.token as string | undefined;
  const bearerToken = req.headers.authorization?.startsWith("Bearer ")
    ? req.headers.authorization.slice(7)
    : undefined;
  const cfEmail = (
    req.headers["cf-access-authenticated-user-email"] as string | undefined
  )?.toLowerCase();

  if (cfEmail) {
    if (!config.allowedEmails.includes(cfEmail)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    req.cfEmail = cfEmail;
    if (config.authToken && (queryToken === config.authToken || bearerToken === config.authToken)) {
      req.readOnly = false;
      next();
      return;
    }
    req.readOnly = true;
    next();
    return;
  }

  if (config.authToken && (queryToken === config.authToken || bearerToken === config.authToken)) {
    req.readOnly = false;
    next();
    return;
  }
  if (config.readonlyToken && (queryToken === config.readonlyToken || bearerToken === config.readonlyToken)) {
    req.readOnly = true;
    next();
    return;
  }

  if (!config.authToken && !config.readonlyToken) {
    req.readOnly = false;
    next();
    return;
  }

  res.status(401).json({ error: "Unauthorized" });
}

/**
 * MCP endpoint auth: legacy tokens checked first, then OAuth bearer auth.
 * If no credentials at all and tokens are configured, falls through to
 * oauthBearerAuth which returns 401 with WWW-Authenticate discovery info.
 */
function mcpAuthMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  const queryToken = req.query.token as string | undefined;
  const bearerToken = req.headers.authorization?.startsWith("Bearer ")
    ? req.headers.authorization.slice(7)
    : undefined;

  // Legacy: query param token
  if (queryToken) {
    if (config.authToken && queryToken === config.authToken) {
      req.readOnly = false;
      return next();
    }
    if (config.readonlyToken && queryToken === config.readonlyToken) {
      req.readOnly = true;
      return next();
    }
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  // Legacy: bearer token matching configured env tokens
  if (bearerToken) {
    if (config.authToken && bearerToken === config.authToken) {
      req.readOnly = false;
      return next();
    }
    if (config.readonlyToken && bearerToken === config.readonlyToken) {
      req.readOnly = true;
      return next();
    }
    // Not a legacy token — try OAuth bearer validation
    oauthBearerAuth(req, res, () => {
      req.readOnly = !req.auth?.scopes.includes("mcp:full");
      next();
    });
    return;
  }

  // No credentials at all
  if (!config.authToken && !config.readonlyToken) {
    // Local dev: open access
    req.readOnly = false;
    return next();
  }

  // Production with no credentials: return 401 with OAuth discovery headers
  oauthBearerAuth(req, res, next);
}

app.use("/mcp", mcpAuthMiddleware);

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

const SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours of inactivity
const SESSION_SWEEP_MS = 5 * 60 * 1000; // sweep every 5 minutes

const sessions = new Map<
  string,
  { transport: StreamableHTTPServerTransport; lastUsedAt: number }
>();

// Periodic sweep of stale sessions — close transport to release SSE connections
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastUsedAt > SESSION_TTL_MS) {
      sessions.delete(id);
      session.transport.close().catch(() => {});
      console.log(`Session expired: ${id}`);
    }
  }
}, SESSION_SWEEP_MS);

app.all("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  try {
    if (req.method === "POST") {
      // Check if this is an initialization request (no session ID)
      if (!sessionId) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, { transport, lastUsedAt: Date.now() });
            console.log(`Session created: ${id}`);
          },
        });

        transport.onclose = () => {
          if (transport.sessionId) {
            sessions.delete(transport.sessionId);
            console.log(`Session closed: ${transport.sessionId}`);
          }
        };

        const server = await createServer({ readOnly: req.readOnly });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }

      // Existing session
      const session = sessions.get(sessionId);
      if (!session) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      session.lastUsedAt = Date.now();
      await session.transport.handleRequest(req, res, req.body);
      return;
    }

    if (req.method === "GET") {
      if (!sessionId) {
        res.status(400).json({ error: "Missing mcp-session-id header" });
        return;
      }
      const session = sessions.get(sessionId);
      if (!session) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      session.lastUsedAt = Date.now();
      await session.transport.handleRequest(req, res);
      return;
    }

    if (req.method === "DELETE") {
      if (!sessionId) {
        res.status(400).json({ error: "Missing mcp-session-id header" });
        return;
      }
      const session = sessions.get(sessionId);
      if (!session) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      await session.transport.handleRequest(req, res);
      sessions.delete(sessionId);
      return;
    }

    res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error(`MCP handler error (session=${sessionId ?? "new"}):`, err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

// Dashboard UI and API
app.use("/dashboard", createDashboardRouter(sessions));

// Google Calendar proxy (read-only, next 7 days)
app.use("/gcal", legacyAuthMiddleware, createGcalRouter());

app.listen(config.httpPort, async () => {
  console.log(`robin-mcp HTTP server listening on port ${config.httpPort}`);
  console.log(`Endpoint: http://localhost:${config.httpPort}/mcp`);
  console.log(`Dashboard: http://localhost:${config.httpPort}/dashboard`);

  // Pre-populate calendar cache and schedule daily 8am CT refresh
  scheduleCalendarRefresh();

  // Prune old analytics and OAuth data on startup
  try {
    pruneOldAnalytics();
    pruneExpiredOAuthData(getDb());
  } catch (err) {
    console.error("Startup pruning failed (non-fatal):", err);
  }

  // Pre-initialize adapters in background so the first session isn't slow
  try {
    const { getAdapterRegistry } = await import("./adapters/registry.js");
    const registry = getAdapterRegistry();
    await registry.ensureInitialized();
    console.log("Adapters pre-initialized");
  } catch (err) {
    console.error("Adapter pre-initialization failed (non-fatal):", err);
  }
});
