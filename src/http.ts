import express from "express";
import crypto from "crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";
import { config } from "./config.js";

const app = express();
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
<p>A personal <a href="https://modelcontextprotocol.io">Model Context Protocol</a> server with tools for notes, bookmarks, Linear issues, GitHub repos, and creative writing resources.</p>
<h3>Connect</h3>
<ul>
<li><strong>MCP endpoint:</strong> <code>/mcp</code></li>
<li><strong>Claude Code:</strong> <code>claude mcp add --transport http robin-mcp [url]/mcp</code></li>
<li><strong>ChatGPT:</strong> Add as a connector in Developer Mode</li>
</ul>
<p class="muted">Built by Robin Cannon</p>
</body></html>`);
});

// Auth middleware: determines access level and stores it on the request.
// Full access: AUTH_TOKEN grants read+write.
// Read-only: READONLY_TOKEN or Cloudflare Access grants read-only.
// No token configured: open access (full).
declare global {
  namespace Express {
    interface Request {
      readOnly?: boolean;
    }
  }
}

app.use("/mcp", (req, res, next) => {
  const queryToken = req.query.token as string | undefined;
  const bearerToken = req.headers.authorization;
  const cfAccess = req.headers["cf-access-authenticated-user-email"];

  // Full access token
  if (config.authToken && (queryToken === config.authToken || bearerToken === `Bearer ${config.authToken}`)) {
    req.readOnly = false;
    next();
    return;
  }

  // Read-only token
  if (config.readonlyToken && (queryToken === config.readonlyToken || bearerToken === `Bearer ${config.readonlyToken}`)) {
    req.readOnly = true;
    next();
    return;
  }

  // Cloudflare Access (read-only for coworkers)
  if (cfAccess) {
    req.readOnly = true;
    next();
    return;
  }

  // No auth configured = open full access (local dev)
  if (!config.authToken && !config.readonlyToken) {
    req.readOnly = false;
    next();
    return;
  }

  res.status(401).json({ error: "Unauthorized" });
});

// Session management: map session IDs to transports
const sessions = new Map<
  string,
  { transport: StreamableHTTPServerTransport }
>();

app.all("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (req.method === "POST") {
    // Check if this is an initialization request (no session ID)
    if (!sessionId) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport });
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
});

app.listen(config.httpPort, () => {
  console.log(`robin-mcp HTTP server listening on port ${config.httpPort}`);
  console.log(`Endpoint: http://localhost:${config.httpPort}/mcp`);
});
