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
    const upsert = db.prepare(
      `INSERT INTO sources (id, name, description, tools, resources)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = ?, description = ?, tools = ?, resources = ?`,
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

      upsert.run(
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
  }
}

// --- Factory ---

let registryInstance: AdapterRegistry | null = null;

export function getAdapterRegistry(): AdapterRegistry {
  if (registryInstance) return registryInstance;

  registryInstance = new AdapterRegistry();

  // Google Workspace adapter (stdio)
  if (config.googleMcpCommand) {
    const env: Record<string, string> = {};
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
