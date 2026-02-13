import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDb } from "../db.js";

interface Source {
  id: string;
  name: string;
  description: string;
  tools: string;
  resources: string;
}

interface SourceRule {
  id: number;
  context: string;
  source_id: string;
  priority: number;
  reason: string;
}

// Cache for the routing guide resource (regenerated infrequently)
const ROUTING_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let routingCacheText: string | null = null;
let routingCacheAt = 0;

/** Call after any write to source_rules, contexts, or sources to bust the cache. */
export function invalidateRoutingCache(): void {
  routingCacheText = null;
}

/** External sources (available via separate MCP servers) use 'ext-' prefix. */
const EXT_PREFIX = "ext-";
const EXT_NOTE = "\n\nNote: Sources marked [External] are conditional — only reference them if you have a direct connection or integration. This server has no visibility into them.";

function buildRoutingGuide(): string {
  const db = getDb();

  const sources = db
    .prepare("SELECT * FROM sources ORDER BY name")
    .all() as Source[];
  const rules = db
    .prepare(
      `SELECT sr.*, s.name as source_name
       FROM source_rules sr
       JOIN sources s ON s.id = sr.source_id
       ORDER BY sr.context, sr.priority`
    )
    .all() as Array<SourceRule & { source_name: string }>;

  const ctxDescs = db
    .prepare("SELECT name, description FROM contexts")
    .all() as Array<{ name: string; description: string }>;
  const descMap = new Map(ctxDescs.map(c => [c.name, c.description]));

  // Group rules by context
  const contexts = new Map<string, Array<SourceRule & { source_name: string }>>();
  for (const rule of rules) {
    const list = contexts.get(rule.context) || [];
    list.push(rule);
    contexts.set(rule.context, list);
  }

  let text = "# Source Routing Guide\n\n";
  text +=
    "Use this guide to determine which tools and sources to prioritize based on the type of question or task.\n\n";

  text += "## Available Sources\n\n";
  for (const s of sources) {
    text += `### ${s.name} (\`${s.id}\`)\n`;
    text += `${s.description}\n`;
    if (s.tools) text += `Tools: ${s.tools}\n`;
    if (s.resources) text += `Resources: ${s.resources}\n`;
    text += "\n";
  }

  text += "## Contextual Rules\n\n";
  text +=
    "When handling a request, identify the context and follow the priority order below (1 = highest priority).\n";
  text +=
    "Sources marked [External] are conditional — only use them if you have direct access via a separate MCP server. This server has no visibility into them.\n\n";
  for (const [context, ctxRules] of contexts) {
    text += `### ${context}\n`;
    const desc = descMap.get(context);
    if (desc) text += `*${desc}*\n\n`;
    for (const r of ctxRules) {
      const prefix = r.source_id.startsWith(EXT_PREFIX) ? "[External] " : "";
      text += `${r.priority}. **${prefix}${r.source_name}** — ${r.reason}\n`;
    }
    text += "\n";
  }

  return text;
}

export function registerSourceTools(server: McpServer, readOnly = false): void {
  // Resource: full source routing guide for Claude to consult
  server.resource(
    "source-routing",
    "robin://sources/routing",
    {
      description:
        "Context-aware source routing guide. Consult this to decide which tools/sources to prioritize for a given question.",
    },
    async (uri) => {
      const now = Date.now();
      if (!routingCacheText || now - routingCacheAt > ROUTING_CACHE_TTL_MS) {
        routingCacheText = buildRoutingGuide();
        routingCacheAt = now;
      }

      return {
        contents: [
          { uri: uri.toString(), mimeType: "text/plain", text: routingCacheText },
        ],
      };
    }
  );

  // Tool: get routing recommendation for a context
  server.tool(
    "get-source-routing",
    "Get the recommended sources and tools for a given context (e.g. 'code', 'creative-writing', 'research')",
    {
      context: z
        .string()
        .describe(
          "The context to get routing for: 'code', 'product-and-project-strategy', 'creative-writing', 'static-drift', 'personal-brand', 'research', 'general'"
        ),
    },
    async ({ context }) => {
      const db = getDb();

      const ctxDesc = db
        .prepare("SELECT description FROM contexts WHERE name = ?")
        .get(context) as { description: string } | undefined;

      const rules = db
        .prepare(
          `SELECT sr.*, s.name, s.tools, s.resources
           FROM source_rules sr
           JOIN sources s ON s.id = sr.source_id
           WHERE sr.context = ?
           ORDER BY sr.priority`
        )
        .all(context) as Array<
        SourceRule & { name: string; tools: string; resources: string }
      >;

      if (rules.length === 0) {
        // Fall back to general
        const general = db
          .prepare(
            `SELECT sr.*, s.name, s.tools, s.resources
             FROM source_rules sr
             JOIN sources s ON s.id = sr.source_id
             WHERE sr.context = 'general'
             ORDER BY sr.priority`
          )
          .all() as Array<
          SourceRule & { name: string; tools: string; resources: string }
        >;

        if (general.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No routing rules found for context "${context}" or "general". Use any available tools.`,
              },
            ],
          };
        }

        const lines = general.map(
          (r) => {
            const prefix = r.source_id.startsWith(EXT_PREFIX) ? "[External] " : "";
            return `${r.priority}. ${prefix}${r.name}: ${r.reason}\n   Tools: ${r.tools || "none"} | Resources: ${r.resources || "none"}`;
          }
        );
        const hasExternal = general.some((r) => r.source_id.startsWith(EXT_PREFIX));
        return {
          content: [
            {
              type: "text" as const,
              text: `No specific rules for "${context}". Falling back to general routing:\n\n${lines.join("\n\n")}${hasExternal ? EXT_NOTE : ""}`,
            },
          ],
        };
      }

      const descLine = ctxDesc?.description ? `\n${ctxDesc.description}\n` : "";
      const lines = rules.map(
        (r) => {
          const prefix = r.source_id.startsWith(EXT_PREFIX) ? "[External] " : "";
          return `${r.priority}. ${prefix}${r.name}: ${r.reason}\n   Tools: ${r.tools || "none"} | Resources: ${r.resources || "none"}`;
        }
      );

      const hasExternal = rules.some((r) => r.source_id.startsWith(EXT_PREFIX));
      return {
        content: [
          {
            type: "text" as const,
            text: `Source routing for "${context}":${descLine}\n${lines.join("\n\n")}${hasExternal ? EXT_NOTE : ""}`,
          },
        ],
      };
    }
  );

  // Tool: add or update a routing rule
  if (!readOnly) server.tool(
    "set-source-rule",
    "Add or update a contextual routing rule for a source. New rules are appended at the bottom; existing rules update the reason only.",
    {
      context: z.string().describe("Context name, e.g. 'code', 'design', 'hiring'"),
      sourceId: z.string().describe("Source ID, e.g. 'linear', 'github', 'kb-notes'"),
      reason: z.string().describe("Why this source is relevant for this context"),
    },
    async ({ context, sourceId, reason }) => {
      const db = getDb();

      const source = db
        .prepare("SELECT id FROM sources WHERE id = ?")
        .get(sourceId) as { id: string } | undefined;

      if (!source) {
        const all = db.prepare("SELECT id FROM sources").all() as Array<{ id: string }>;
        return {
          content: [
            {
              type: "text" as const,
              text: `Source "${sourceId}" not found. Available: ${all.map((s) => s.id).join(", ")}`,
            },
          ],
          isError: true,
        };
      }

      // Check if rule already exists
      const existing = db
        .prepare("SELECT id, priority FROM source_rules WHERE context = ? AND source_id = ?")
        .get(context, sourceId) as { id: number; priority: number } | undefined;

      if (existing) {
        db.prepare("UPDATE source_rules SET reason = ? WHERE id = ?")
          .run(reason, existing.id);
        invalidateRoutingCache();
        return {
          content: [
            {
              type: "text" as const,
              text: `Rule updated: "${context}" → ${sourceId} at priority ${existing.priority} (reason updated)`,
            },
          ],
        };
      }

      // New rule: append at max+1
      const maxRow = db
        .prepare("SELECT COALESCE(MAX(priority), 0) as max_p FROM source_rules WHERE context = ?")
        .get(context) as { max_p: number };
      const newPriority = maxRow.max_p + 1;

      db.prepare(
        "INSERT INTO source_rules (context, source_id, priority, reason) VALUES (?, ?, ?, ?)"
      ).run(context, sourceId, newPriority, reason);

      // Auto-create context entry if new
      db.prepare("INSERT OR IGNORE INTO contexts (name, description) VALUES (?, '')").run(context);
      invalidateRoutingCache();

      return {
        content: [
          {
            type: "text" as const,
            text: `Rule set: "${context}" → ${sourceId} at priority ${newPriority}`,
          },
        ],
      };
    }
  );

  // Tool: register a new source
  if (!readOnly) server.tool(
    "register-source",
    "Register a new context source with its tools and resources",
    {
      id: z.string().describe("Unique source ID, e.g. 'notion', 'slack'"),
      name: z.string().describe("Display name"),
      description: z.string().describe("What this source provides"),
      tools: z.string().optional().describe("Comma-separated tool names this source provides"),
      resources: z.string().optional().describe("Comma-separated resource URIs this source provides"),
    },
    async ({ id, name, description, tools, resources }) => {
      const db = getDb();

      db.prepare(
        `INSERT INTO sources (id, name, description, tools, resources)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = ?, description = ?, tools = ?, resources = ?`
      ).run(id, name, description, tools || "", resources || "", name, description, tools || "", resources || "");
      invalidateRoutingCache();

      return {
        content: [
          {
            type: "text" as const,
            text: `Source "${name}" (${id}) registered.\nTools: ${tools || "none"}\nResources: ${resources || "none"}`,
          },
        ],
      };
    }
  );
}
