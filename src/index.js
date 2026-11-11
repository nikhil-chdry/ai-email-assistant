import "dotenv/config";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./mcp/server.js";
import { logError, logInfo } from "./utils/logger.js";

async function main() {
  const server = await createMcpServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);
  logInfo("MCP server connected via stdio");
}

main().catch((error) => {
  logError("MCP server failed to start", error);
  process.exitCode = 1;
});

