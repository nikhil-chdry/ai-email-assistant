import { afterEach, describe, expect, it } from "vitest";
import { once } from "node:events";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createMcpServer } from "../src/mcp/server.js";

const temporaryDirectories = [];

async function createTestApplication() {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-email-assistant-"));
  temporaryDirectories.push(temporaryDirectory);
  const server = await createMcpServer({
    databasePath: path.join(temporaryDirectory, "profile.sqlite"),
    uploadsDirectory: path.join(temporaryDirectory, "uploads"),
  });
  const client = new Client({ name: "phase-2-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

function createMinimalPdf(text) {
  const stream = `BT\n/F1 18 Tf\n72 720 Td\n(${text}) Tj\nET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("AI Email Assistant MCP server", () => {
  it("discovers Phase 2 profile tools and returns status", async () => {
    const { server, client } = await createTestApplication();
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "get_system_status",
      "get_my_profile",
      "update_my_profile",
      "upload_resume",
      "get_resume_information",
    ]));

    const result = await client.callTool({ name: "get_system_status", arguments: {} });
    expect(result.structuredContent).toMatchObject({ status: "ready", phase: 2, transport: "stdio" });

    await client.close();
    await server.close();
    await server.closeDatabase();
  });

  it("seeds and updates the candidate profile", async () => {
    const { server, client } = await createTestApplication();
    const initial = await client.callTool({ name: "get_my_profile", arguments: {} });
    expect(initial.structuredContent).toMatchObject({ fullName: "Nikhil Sunda", hasResume: false });

    const updated = await client.callTool({
      name: "update_my_profile",
      arguments: { projects: ["Privacy Scanner", "Smart Shop Platform"] },
    });
    expect(updated.structuredContent.projects).toEqual(["Privacy Scanner", "Smart Shop Platform"]);

    await client.close();
    await server.close();
    await server.closeDatabase();
  });

  it("uploads, parses, and protects replacement of a PDF resume", async () => {
    const { server, client } = await createTestApplication();
    const temporaryDirectory = temporaryDirectories.at(-1);
    const resumePath = path.join(temporaryDirectory, "Nikhil-Resume.pdf");
    await fs.writeFile(resumePath, createMinimalPdf("Nikhil Sunda Software Engineering Resume"));

    const uploaded = await client.callTool({ name: "upload_resume", arguments: { sourcePath: resumePath } });
    expect(uploaded.isError).not.toBe(true);
    expect(uploaded.structuredContent).toMatchObject({ originalFilename: "Nikhil-Resume.pdf" });

    const information = await client.callTool({ name: "get_resume_information", arguments: {} });
    expect(information.structuredContent).toMatchObject({ hasResume: true });
    expect(information.structuredContent.extractedText).toContain("Nikhil Sunda Software Engineering Resume");

    const replacement = await client.callTool({ name: "upload_resume", arguments: { sourcePath: resumePath } });
    expect(replacement.isError).toBe(true);

    const confirmedReplacement = await client.callTool({
      name: "upload_resume",
      arguments: { sourcePath: resumePath, confirmReplace: true },
    });
    expect(confirmedReplacement.isError).not.toBe(true);

    await client.close();
    await server.close();
    await server.closeDatabase();
  });

  it("keeps startup diagnostics off stdout", async () => {
    const entryPoint = fileURLToPath(new URL("../src/index.js", import.meta.url));
    const child = spawn(process.execPath, [entryPoint], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    const startupLogged = new Promise((resolve) => {
      child.stderr.once("data", (chunk) => { stderr += chunk; resolve(); });
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    await Promise.race([startupLogged, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    child.kill();
    await once(child, "close");

    expect(stdout).toBe("");
    expect(stderr).toContain("MCP server connected via stdio");
  });
});
