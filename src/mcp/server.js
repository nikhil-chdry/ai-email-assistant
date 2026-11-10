import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSystemTools } from "./tools/system.tools.js";

export function createMcpServer() {
  const server = new McpServer({
    name: "ai-email-assistant",
    version: "1.0.0",
  });

  registerSystemTools(server);
  return server;
}

