import { describe, expect, it } from "vitest";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createMcpServer } from "../src/mcp/server.js";

describe("AI Email Assistant MCP server", () => {
  it("discovers get_system_status and returns Phase 1 status", async () => {
    const server = createMcpServer();
    const client = new Client({ name: "phase-1-test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("get_system_status");

    const result = await client.callTool({ name: "get_system_status", arguments: {} });
    expect(result.structuredContent).toMatchObject({
      status: "ready",
      phase: 1,
      transport: "stdio",
    });

    await client.close();
    await server.close();
  });

  it("keeps startup diagnostics off stdout", async () => {
    const entryPoint = fileURLToPath(new URL("../src/index.js", import.meta.url));
    const child = spawn(process.execPath, [entryPoint], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    const startupLogged = new Promise((resolve) => {
      child.stderr.once("data", (chunk) => {
        stderr += chunk;
        resolve();
      });
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    await Promise.race([
      startupLogged,
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    child.kill();
    await once(child, "close");

    expect(stdout).toBe("");
    expect(stderr).toContain("MCP server connected via stdio");
  });
});

