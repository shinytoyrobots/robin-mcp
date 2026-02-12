import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb } from "../db.js";
import { config } from "../config.js";
import { jsonSchemaToZodShape } from "./schema-utils.js";
import { McpProxyAdapter } from "./mcp-proxy.js";
import type { SourceAdapter, AdapterToolDefinition } from "./types.js";
import { logAdapterHealth, invalidateSourceCache } from "../analytics/tracker.js";

export class AdapterRegistry {
  private adapters: SourceAdapter[] = [];
  private initialized = false;

  addAdapter(adapter: SourceAdapter): void {
    this.adapters.push(adapter);
  }

  async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    const enabledAdapters = this.adapters.filter(a => a.config.enabled);

    await Promise.allSettled(
      enabledAdapters.map(async (adapter) => {
        const start = Date.now();
        try {
          await adapter.initialize();
          const initDurationMs = Date.now() - start;
          logAdapterHealth({
            adapterId: adapter.config.id,
            status: "up",
            initDurationMs,
            toolCount: adapter.getTools().length,
            resourceCount: adapter.getResources().length,
          });
        } catch (err) {
          const initDurationMs = Date.now() - start;
          const errorMessage = err instanceof Error ? err.message : String(err);
          logAdapterHealth({
            adapterId: adapter.config.id,
            status: "down",
            initDurationMs,
            errorMessage,
          });
          console.error(
            `[adapter:${adapter.config.id}] Failed to initialize (non-fatal):`,
            errorMessage,
          );
        }
      }),
    );

    invalidateSourceCache();
    this.syncSourcesToDb();
  }

  registerOnServer(server: McpServer, readOnly: boolean): void {
    for (const adapter of this.adapters) {
      if (!adapter.config.enabled) continue;

      const tools = adapter.getTools();
      const prefix = adapter.config.prefix;

      for (const tool of tools) {
        if (readOnly && tool.isWrite) continue;

        const prefixedName = `${prefix}${tool.name}`;
        const schema = tool.inputSchema as {
          properties?: Record<string, Record<string, unknown>>;
          required?: string[];
        };
        const zodShape = jsonSchemaToZodShape(schema.properties, schema.required);

        server.tool(
          prefixedName,
          tool.description,
          zodShape,
          async (args: Record<string, unknown>) => {
            try {
              return await adapter.callTool(tool.name, args);
            } catch (err) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `Error calling ${prefixedName}: ${err instanceof Error ? err.message : String(err)}`,
                  },
                ],
                isError: true,
              };
            }
          },
        );
      }

      // Register resources with prefixed URIs
      for (const resource of adapter.getResources()) {
        const prefixedUri = `robin://adapter/${adapter.config.id}/${resource.uri}`;
        server.resource(
          `${prefix}${resource.name}`,
          prefixedUri,
          { description: resource.description, mimeType: resource.mimeType },
          async () => {
            const result = await adapter.readResource(resource.uri);
            return {
              contents: result.contents.map((c) => ({
                ...c,
                uri: prefixedUri,
              })),
            };
          },
        );
      }
    }
  }

  async shutdownAll(): Promise<void> {
    for (const adapter of this.adapters) {
      try {
        await adapter.shutdown();
      } catch (err) {
        console.error(
          `[adapter:${adapter.config.id}] Shutdown error:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  private syncSourcesToDb(): void {
    const db = getDb();
    const upsertSource = db.prepare(
      `INSERT INTO sources (id, name, description, tools, resources)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = ?, description = ?, tools = ?, resources = ?`,
    );
    const checkRule = db.prepare(
      "SELECT id FROM source_rules WHERE context = ? AND source_id = ?",
    );
    const updateReason = db.prepare(
      "UPDATE source_rules SET reason = ? WHERE context = ? AND source_id = ?",
    );
    const maxPriority = db.prepare(
      "SELECT COALESCE(MAX(priority), 0) as max_p FROM source_rules WHERE context = ?",
    );
    const insertRule = db.prepare(
      "INSERT INTO source_rules (context, source_id, priority, reason) VALUES (?, ?, ?, ?)",
    );

    const ensureRule = (context: string, sourceId: string, reason: string) => {
      const existing = checkRule.get(context, sourceId);
      if (existing) {
        updateReason.run(reason, context, sourceId);
      } else {
        const row = maxPriority.get(context) as { max_p: number };
        insertRule.run(context, sourceId, row.max_p + 1, reason);
      }
    };

    for (const adapter of this.adapters) {
      if (!adapter.config.enabled) continue;

      const tools = adapter.getTools();
      const resources = adapter.getResources();
      const prefix = adapter.config.prefix;

      const toolNames = tools.map((t) => `${prefix}${t.name}`).join(",");
      const resourceUris = resources
        .map((r) => `robin://adapter/${adapter.config.id}/${r.uri}`)
        .join(",");

      upsertSource.run(
        adapter.config.id,
        adapter.config.name,
        adapter.config.description,
        toolNames,
        resourceUris,
        adapter.config.name,
        adapter.config.description,
        toolNames,
        resourceUris,
      );
    }

    // Register per-account logical sources for Google adapter
    if (this.adapters.some((a) => a.config.id === "gdocs" && a.config.enabled)) {
      const gdocs = this.adapters.find((a) => a.config.id === "gdocs")!;
      const tools = gdocs.getTools();
      const prefix = gdocs.config.prefix;
      const toolNames = tools.map((t) => `${prefix}${t.name}`).join(",");

      upsertSource.run(
        "gdocs-work",
        "Google Workspace (Work)",
        "Google Docs & Drive for robin@knapsack.cloud. Use account parameter 'robin@knapsack.cloud' with gdocs-* tools. Contains Knapsack work docs, meeting notes, and professional content.",
        toolNames, "",
        "Google Workspace (Work)",
        "Google Docs & Drive for robin@knapsack.cloud. Use account parameter 'robin@knapsack.cloud' with gdocs-* tools. Contains Knapsack work docs, meeting notes, and professional content.",
        toolNames, "",
      );

      upsertSource.run(
        "gdocs-personal",
        "Google Workspace (Personal)",
        "Google Docs & Drive for robin.cannon@gmail.com. Use account parameter 'robin.cannon@gmail.com' with gdocs-* tools. Contains personal docs, creative writing drafts, and mixed-use content.",
        toolNames, "",
        "Google Workspace (Personal)",
        "Google Docs & Drive for robin.cannon@gmail.com. Use account parameter 'robin.cannon@gmail.com' with gdocs-* tools. Contains personal docs, creative writing drafts, and mixed-use content.",
        toolNames, "",
      );

      // Routing rules for work account
      ensureRule("product-and-project-strategy", "gdocs-work", "Work Google Docs may contain meeting notes and project docs (use account: robin@knapsack.cloud)");
      ensureRule("code", "gdocs-work", "Work Google Docs may contain technical specs and design docs (use account: robin@knapsack.cloud)");

      // Routing rules for personal account
      ensureRule("creative-writing", "gdocs-personal", "Personal Google Docs may contain writing drafts (use account: robin.cannon@gmail.com)");
      ensureRule("research", "gdocs-personal", "Personal Google Docs may contain research notes (use account: robin.cannon@gmail.com)");
      ensureRule("general", "gdocs-personal", "Personal Google Docs for general documents (use account: robin.cannon@gmail.com)");
    }

    // Routing rules for Notion adapters
    if (this.adapters.some((a) => a.config.id === "notion-work" && a.config.enabled)) {
      ensureRule("product-and-project-strategy", "notion-work", "Work Notion contains project docs, specs, and team knowledge base");
      ensureRule("code", "notion-work", "Work Notion may contain technical specs, architecture docs, and engineering decisions");
    }

    if (this.adapters.some((a) => a.config.id === "notion-personal" && a.config.enabled)) {
      ensureRule("creative-writing", "notion-personal", "Personal Notion contains fiction planning, world-building notes, and writing drafts");
      ensureRule("static-drift", "notion-personal", "Personal Notion may contain Static Drift planning and story notes");
      ensureRule("research", "notion-personal", "Personal Notion contains research notes, collected references, and project planning");
      ensureRule("general", "notion-personal", "Personal Notion for todos, scheduling, personal projects, and general notes");
      ensureRule("personal-brand", "notion-personal", "Personal Notion may contain content planning and personal project notes");
    }

    // Digest pipeline routing rules
    if (this.adapters.some((a) => a.config.id === "digest" && a.config.enabled)) {
      ensureRule("research", "digest", "Content digests provide curated insights from PM and industry blogs");
      ensureRule("general", "digest", "Content digests may contain relevant curated knowledge snippets");
    }
  }
}

// --- Factory ---

let registryInstance: AdapterRegistry | null = null;

export function getAdapterRegistry(): AdapterRegistry {
  if (registryInstance) return registryInstance;

  registryInstance = new AdapterRegistry();

  // Google Workspace adapter (stdio)
  if (config.googleMcpCommand) {
    const env: Record<string, string> = {
      // Disable services we don't need — faster startup and avoids
      // nil-pointer crash in google-mcp-server v0.3.0 multi-account mode.
      DISABLE_SHEETS: "true",
      DISABLE_SLIDES: "true",
      DISABLE_CALENDAR: "true",
      DISABLE_GMAIL: "true",
    };
    if (config.googleClientId) env.GOOGLE_CLIENT_ID = config.googleClientId;
    if (config.googleClientSecret) env.GOOGLE_CLIENT_SECRET = config.googleClientSecret;

    registryInstance.addAdapter(
      new McpProxyAdapter({
        id: "gdocs",
        name: "Google Workspace",
        prefix: "gdocs-",
        type: "mcp-proxy",
        transport: "stdio",
        description: "Google Docs, Drive, and Workspace via google-mcp-server",
        enabled: true,
        command: config.googleMcpCommand,
        env: Object.keys(env).length > 0 ? env : undefined,
        toolFilter: [
          "docs_document_get",
          "docs_document_create",
          "docs_document_update",
          "drive_files_list",
          "drive_files_search",
          "drive_file_get_metadata",
          "drive_markdown_upload",
          "drive_markdown_replace",
          "accounts_list",
        ],
        writeTools: [
          "docs_document_create",
          "docs_document_update",
          "drive_markdown_upload",
          "drive_markdown_replace",
        ],
        timeoutMs: 120000,
      }),
    );
  }

  // Notion adapters (stdio, per-workspace)
  const notionToolFilter = [
    "API-post-search",
    "API-retrieve-a-page",
    "API-get-block-children",
    "API-retrieve-a-page-property",
    "API-retrieve-a-database",
    "API-query-data-source",
    "API-retrieve-a-data-source",
  ];
  const notionArgs = config.notionMcpCommand === "npx"
    ? ["-y", "@notionhq/notion-mcp-server"]
    : undefined;

  if (config.notionMcpCommand && config.notionTokenPersonal) {
    registryInstance.addAdapter(
      new McpProxyAdapter({
        id: "notion-personal",
        name: "Notion (Personal)",
        prefix: "notion-personal-",
        type: "mcp-proxy",
        transport: "stdio",
        description: "Personal Notion workspace — fiction, creative writing, personal todos, scheduling, personal projects, research notes. Not for work/professional content.",
        enabled: true,
        command: config.notionMcpCommand,
        args: notionArgs,
        env: { NOTION_TOKEN: config.notionTokenPersonal },
        toolFilter: notionToolFilter,
      }),
    );
  }

  if (config.notionMcpCommand && config.notionTokenWork) {
    registryInstance.addAdapter(
      new McpProxyAdapter({
        id: "notion-work",
        name: "Notion (Work)",
        prefix: "notion-work-",
        type: "mcp-proxy",
        transport: "stdio",
        description: "Knapsack work Notion workspace — project docs, specs, and team knowledge",
        enabled: true,
        command: config.notionMcpCommand,
        args: notionArgs,
        env: { NOTION_TOKEN: config.notionTokenWork },
        toolFilter: notionToolFilter,
      }),
    );
  }

  // Toby adapter (HTTP, for later)
  if (config.tobyMcpUrl) {
    registryInstance.addAdapter(
      new McpProxyAdapter({
        id: "toby",
        name: "Toby",
        prefix: "toby-",
        type: "mcp-proxy",
        transport: "http",
        description: "Toby MCP server",
        enabled: true,
        url: config.tobyMcpUrl,
        headers: config.tobyMcpToken
          ? { Authorization: `Bearer ${config.tobyMcpToken}` }
          : undefined,
      }),
    );
  }

  // Digest pipeline adapter (HTTP)
  if (config.digestPipelineUrl) {
    registryInstance.addAdapter(
      new McpProxyAdapter({
        id: "digest",
        name: "Content Digests",
        prefix: "digest-",
        type: "mcp-proxy",
        transport: "http",
        description: "Curated content digests from blog pipelines",
        enabled: true,
        url: config.digestPipelineUrl,
        headers: config.digestPipelineToken
          ? { Authorization: `Bearer ${config.digestPipelineToken}` }
          : undefined,
        toolFilter: ["list-digests", "get-digest", "search-digests"],
      }),
    );
  }

  return registryInstance;
}
