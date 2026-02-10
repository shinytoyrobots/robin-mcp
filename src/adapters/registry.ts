import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb } from "../db.js";
import { config } from "../config.js";
import { jsonSchemaToZodShape } from "./schema-utils.js";
import { McpProxyAdapter } from "./mcp-proxy.js";
import type { SourceAdapter, AdapterToolDefinition } from "./types.js";

export class AdapterRegistry {
  private adapters: SourceAdapter[] = [];
  private initialized = false;

  addAdapter(adapter: SourceAdapter): void {
    this.adapters.push(adapter);
  }

  async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    for (const adapter of this.adapters) {
      if (!adapter.config.enabled) continue;

      try {
        await adapter.initialize();
      } catch (err) {
        console.error(
          `[adapter:${adapter.config.id}] Failed to initialize (non-fatal):`,
          err instanceof Error ? err.message : err,
        );
      }
    }

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
    const upsertRule = db.prepare(
      `INSERT INTO source_rules (context, source_id, priority, reason)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(context, source_id) DO UPDATE SET priority = ?, reason = ?`,
    );

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
      upsertRule.run("project-management", "gdocs-work", 2, "Work Google Docs may contain meeting notes and project docs (use account: robin@knapsack.cloud)", 2, "Work Google Docs may contain meeting notes and project docs (use account: robin@knapsack.cloud)");
      upsertRule.run("code", "gdocs-work", 4, "Work Google Docs may contain technical specs and design docs (use account: robin@knapsack.cloud)", 4, "Work Google Docs may contain technical specs and design docs (use account: robin@knapsack.cloud)");

      // Routing rules for personal account
      upsertRule.run("creative-writing", "gdocs-personal", 4, "Personal Google Docs may contain writing drafts (use account: robin.cannon@gmail.com)", 4, "Personal Google Docs may contain writing drafts (use account: robin.cannon@gmail.com)");
      upsertRule.run("research", "gdocs-personal", 3, "Personal Google Docs may contain research notes (use account: robin.cannon@gmail.com)", 3, "Personal Google Docs may contain research notes (use account: robin.cannon@gmail.com)");
      upsertRule.run("general", "gdocs-personal", 4, "Personal Google Docs for general documents (use account: robin.cannon@gmail.com)", 4, "Personal Google Docs for general documents (use account: robin.cannon@gmail.com)");
    }

    // Routing rules for Notion adapters
    if (this.adapters.some((a) => a.config.id === "notion-work" && a.config.enabled)) {
      upsertRule.run("project-management", "notion-work", 2, "Work Notion contains project docs, specs, and team knowledge base", 2, "Work Notion contains project docs, specs, and team knowledge base");
      upsertRule.run("code", "notion-work", 3, "Work Notion may contain technical specs, architecture docs, and engineering decisions", 3, "Work Notion may contain technical specs, architecture docs, and engineering decisions");
    }

    if (this.adapters.some((a) => a.config.id === "notion-personal" && a.config.enabled)) {
      upsertRule.run("creative-writing", "notion-personal", 2, "Personal Notion contains fiction planning, world-building notes, and writing drafts", 2, "Personal Notion contains fiction planning, world-building notes, and writing drafts");
      upsertRule.run("static-drift", "notion-personal", 3, "Personal Notion may contain Static Drift planning and story notes", 3, "Personal Notion may contain Static Drift planning and story notes");
      upsertRule.run("research", "notion-personal", 2, "Personal Notion contains research notes, collected references, and project planning", 2, "Personal Notion contains research notes, collected references, and project planning");
      upsertRule.run("general", "notion-personal", 2, "Personal Notion for todos, scheduling, personal projects, and general notes", 2, "Personal Notion for todos, scheduling, personal projects, and general notes");
      upsertRule.run("personal-brand", "notion-personal", 3, "Personal Notion may contain content planning and personal project notes", 3, "Personal Notion may contain content planning and personal project notes");
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

  return registryInstance;
}
