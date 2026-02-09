import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

// Never write to stdout - it corrupts the MCP protocol.
// Use console.error for all logging.

const server = await createServer();
const transport = new StdioServerTransport();

await server.connect(transport);
console.error("robin-mcp: stdio transport connected");
