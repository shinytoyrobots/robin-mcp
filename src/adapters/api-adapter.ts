import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  SourceAdapter,
  AdapterConfig,
  AdapterToolDefinition,
  AdapterResourceDefinition,
} from "./types.js";

/**
 * Skeleton adapter for future REST/GraphQL API integrations.
 * Extend this class to wrap non-MCP APIs as adapter sources.
 */
export abstract class ApiAdapter implements SourceAdapter {
  readonly config: AdapterConfig;

  constructor(config: AdapterConfig) {
    this.config = config;
  }

  abstract initialize(): Promise<void>;
  abstract getTools(): AdapterToolDefinition[];
  abstract getResources(): AdapterResourceDefinition[];
  abstract callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  abstract readResource(uri: string): Promise<ReadResourceResult>;
  abstract shutdown(): Promise<void>;
}
