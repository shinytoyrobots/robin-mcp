import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerNoteTools } from "./tools/notes.js";
import { registerBookmarkTools } from "./tools/bookmarks.js";
import { registerApiGatewayTools } from "./tools/api-gateway.js";
import { registerVaultTools } from "./tools/vault.js";
import { registerLinearTools } from "./tools/linear.js";
import { registerSourceTools } from "./tools/sources.js";
import { registerWritingsResources } from "./resources/writings.js";
import { registerKnowledgeBaseResources } from "./resources/knowledge-base.js";
import { getAdapterRegistry } from "./adapters/registry.js";
import { instrumentServer } from "./analytics/instrument.js";

export async function createServer(options?: { readOnly?: boolean }): Promise<McpServer> {
  const readOnly = options?.readOnly ?? false;

  const server = new McpServer({
    name: "robin-mcp",
    version: "1.0.0",
  });

  instrumentServer(server, { authLevel: readOnly ? "readonly" : "full" });

  // Register native tools
  registerNoteTools(server, readOnly);
  registerBookmarkTools(server, readOnly);
  registerApiGatewayTools(server);
  registerVaultTools(server);
  registerLinearTools(server, readOnly);
  registerSourceTools(server, readOnly);

  // Register native resources
  registerWritingsResources(server);
  registerKnowledgeBaseResources(server);

  // Register adapter tools and resources (full-access sessions only)
  if (!readOnly) {
    const registry = getAdapterRegistry();
    await registry.ensureInitialized();
    registry.registerOnServer(server, readOnly);
  }

  return server;
}
