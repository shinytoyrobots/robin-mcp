import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerNoteTools } from "./tools/notes.js";
import { registerBookmarkTools } from "./tools/bookmarks.js";
import { registerApiGatewayTools } from "./tools/api-gateway.js";
import { registerVaultTools } from "./tools/vault.js";
import { registerLinearTools } from "./tools/linear.js";
import { registerSourceTools } from "./tools/sources.js";
import { registerWritingsResources } from "./resources/writings.js";
import { registerKnowledgeBaseResources } from "./resources/knowledge-base.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "robin-mcp",
    version: "1.0.0",
  });

  // Register tools
  registerNoteTools(server);
  registerBookmarkTools(server);
  registerApiGatewayTools(server);
  registerVaultTools(server);
  registerLinearTools(server);
  registerSourceTools(server);

  // Register resources
  registerWritingsResources(server);
  registerKnowledgeBaseResources(server);

  return server;
}
