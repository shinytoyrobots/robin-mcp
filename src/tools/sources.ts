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
        "When handling a request, identify the context and follow the priority order below (1 = highest priority).\n\n";
      for (const [context, ctxRules] of contexts) {
        text += `### ${context}\n`;
        for (const r of ctxRules) {
          text += `${r.priority}. **${r.source_name}** — ${r.reason}\n`;
        }
        text += "\n";
      }

      return {
        contents: [
          { uri: uri.toString(), mimeType: "text/plain", text },
        ],
      };
    }
  );

  // Tool: get routing recommendation for a context
  server.tool(
    "get-source-routing",
    "Get the recommended sources and tools for a given context (e.g. 'code', 'project-management', 'creative-writing')",
    {
      context: z
        .string()
        .describe(
          "The context to get routing for, e.g. 'code', 'project-management', 'creative-writing', 'research', 'personal-brand', 'general'"
        ),
    },
    async ({ context }) => {
      const db = getDb();

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
          (r) =>
            `${r.priority}. ${r.name}: ${r.reason}\n   Tools: ${r.tools || "none"} | Resources: ${r.resources || "none"}`
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `No specific rules for "${context}". Falling back to general routing:\n\n${lines.join("\n\n")}`,
            },
          ],
        };
      }

      const lines = rules.map(
        (r) =>
          `${r.priority}. ${r.name}: ${r.reason}\n   Tools: ${r.tools || "none"} | Resources: ${r.resources || "none"}`
      );

      return {
        content: [
          {
            type: "text" as const,
            text: `Source routing for "${context}":\n\n${lines.join("\n\n")}`,
          },
        ],
      };
    }
  );

  // Tool: add or update a routing rule
  if (!readOnly) server.tool(
    "set-source-rule",
    "Add or update a contextual routing rule for a source",
    {
      context: z.string().describe("Context name, e.g. 'code', 'design', 'hiring'"),
      sourceId: z.string().describe("Source ID, e.g. 'linear', 'github', 'kb-notes'"),
      priority: z.number().describe("Priority (1 = highest)"),
      reason: z.string().describe("Why this source is relevant for this context"),
    },
    async ({ context, sourceId, priority, reason }) => {
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

      db.prepare(
        `INSERT INTO source_rules (context, source_id, priority, reason)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(context, source_id) DO UPDATE SET priority = ?, reason = ?`
      ).run(context, sourceId, priority, reason, priority, reason);

      return {
        content: [
          {
            type: "text" as const,
            text: `Rule set: "${context}" → ${sourceId} at priority ${priority}`,
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
