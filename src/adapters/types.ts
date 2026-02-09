import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";

// --- Adapter interface ---

export interface SourceAdapter {
  readonly config: AdapterConfig;
  initialize(): Promise<void>;
  getTools(): AdapterToolDefinition[];
  getResources(): AdapterResourceDefinition[];
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  readResource(uri: string): Promise<ReadResourceResult>;
  shutdown(): Promise<void>;
}

// --- Tool / resource definitions ---

export interface AdapterToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  isWrite: boolean;
}

export interface AdapterResourceDefinition {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

// --- Config types ---

export interface AdapterConfig {
  id: string;
  name: string;
  prefix: string;
  type: "mcp-proxy" | "api-adapter" | "static";
  description: string;
  enabled: boolean;
  toolFilter?: string[];
  writeTools?: string[];  // explicitly mark tools as writes (for upstreams without annotations)
}

export interface McpProxyStdioConfig extends AdapterConfig {
  type: "mcp-proxy";
  transport: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpProxyHttpConfig extends AdapterConfig {
  type: "mcp-proxy";
  transport: "http";
  url: string;
  headers?: Record<string, string>;
}

export type McpProxyConfig = McpProxyStdioConfig | McpProxyHttpConfig;
