import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult, ReadResourceResult, Tool, Resource } from "@modelcontextprotocol/sdk/types.js";
import type {
  SourceAdapter,
  McpProxyConfig,
  AdapterToolDefinition,
  AdapterResourceDefinition,
} from "./types.js";

export class McpProxyAdapter implements SourceAdapter {
  readonly config: McpProxyConfig;
  private client: Client | null = null;
  private tools: AdapterToolDefinition[] = [];
  private resources: AdapterResourceDefinition[] = [];

  constructor(config: McpProxyConfig) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    const transport = this.config.transport === "stdio"
      ? new StdioClientTransport({
          command: this.config.command,
          args: this.config.args,
          env: this.config.env
            ? { ...process.env, ...this.config.env } as Record<string, string>
            : undefined,
        })
      : new StreamableHTTPClientTransport(
          new URL(this.config.url),
          this.config.headers
            ? { requestInit: { headers: this.config.headers } }
            : undefined,
        );

    this.client = new Client(
      { name: `robin-mcp-adapter-${this.config.id}`, version: "1.0.0" },
      { capabilities: {} },
    );

    await this.client.connect(transport);

    // Discover tools
    const toolsResult = await this.client.listTools();
    const writeSet = this.config.writeTools
      ? new Set(this.config.writeTools)
      : null;

    this.tools = (toolsResult.tools || []).map((t: Tool) => ({
      name: t.name,
      description: t.description || "",
      inputSchema: t.inputSchema as Record<string, unknown>,
      isWrite: writeSet ? writeSet.has(t.name) : isWriteTool(t),
    }));

    // Discover resources
    const resourcesResult = await this.client.listResources();
    this.resources = (resourcesResult.resources || []).map((r: Resource) => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
      mimeType: r.mimeType,
    }));

    console.error(
      `[adapter:${this.config.id}] Initialized: ${this.tools.length} tools, ${this.resources.length} resources`,
    );
  }

  getTools(): AdapterToolDefinition[] {
    if (this.config.toolFilter) {
      const allowed = new Set(this.config.toolFilter);
      return this.tools.filter((t) => allowed.has(t.name));
    }
    return this.tools;
  }

  getResources(): AdapterResourceDefinition[] {
    return this.resources;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    if (!this.client) throw new Error(`Adapter ${this.config.id} not initialized`);
    const result = await this.client.callTool({ name, arguments: args });
    return result as CallToolResult;
  }

  async readResource(uri: string): Promise<ReadResourceResult> {
    if (!this.client) throw new Error(`Adapter ${this.config.id} not initialized`);
    const result = await this.client.readResource({ uri });
    return result as ReadResourceResult;
  }

  async shutdown(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      console.error(`[adapter:${this.config.id}] Shut down`);
    }
  }
}

/**
 * Determine if a tool is a write tool based on MCP annotations.
 * Write = not marked readOnlyHint, or marked destructiveHint.
 */
function isWriteTool(tool: Tool): boolean {
  const annotations = tool.annotations as
    | { readOnlyHint?: boolean; destructiveHint?: boolean }
    | undefined;

  if (!annotations) return false; // assume read if no annotations
  if (annotations.destructiveHint) return true;
  if (annotations.readOnlyHint === false) return true;
  return false;
}
