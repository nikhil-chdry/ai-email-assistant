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
  it("discovers Phase 10 tools and returns status", async () => {
    const { server, client } = await createTestApplication();
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "get_system_status",
      "get_my_profile",
      "update_my_profile",
      "upload_resume",
      "get_resume_information",
      "create_recruiter",
      "import_recruiters",
      "list_recruiters",
      "search_recruiters",
      "filter_recruiters",
      "validate_contacts",
      "update_recruiter",
      "delete_recruiter",
      "generate_email",
      "save_email_draft",
      "get_email_drafts",
      "update_email_draft",
      "delete_email_draft",
      "connect_gmail",
      "get_gmail_status",
      "send_test_email",
      "create_campaign",
      "preview_campaign",
      "approve_campaign",
      "send_campaign",
      "pause_campaign",
      "resume_campaign",
      "stop_campaign",
      "get_campaign_report",
      "check_replies",
      "schedule_followups",
      "get_pending_followups",
      "generate_followup",
      "classify_reply",
    ]));

    const result = await client.callTool({ name: "get_system_status", arguments: {} });
    expect(result.structuredContent).toMatchObject({
      status: "ready",
      phase: 10,
      transport: "stdio",
      capabilities: {
        securityHardened: true,
        productionReady: true,
      },
    });

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

  it("imports and manages recruiters without claiming deliverability verification", async () => {
    const { server, client } = await createTestApplication();
    const temporaryDirectory = temporaryDirectories.at(-1);
    const manual = await client.callTool({
      name: "create_recruiter",
      arguments: { name: "Lina Das", email: "lina@beta.example", company: "Beta Systems", jobRole: "Full Stack Developer" },
    });
    expect(manual.structuredContent).toMatchObject({ name: "Lina Das", emailFormatValid: true });

    const csvPath = path.join(temporaryDirectory, "recruiters.csv");
    await fs.writeFile(csvPath, [
      "name,email,company,designation,job_role,company_website,source",
      "Asha Verma,asha@acme.example,Acme Labs,Technical Recruiter,SDE Intern,https://acme.example,public careers page",
      "Ravi Shah,not-an-email,Acme Labs,Recruiter,Backend Developer,https://acme.example,conference contact",
      "Duplicate Asha,ASHA@ACME.EXAMPLE,Acme Labs,Recruiter,SDE Intern,https://acme.example,duplicate row",
    ].join("\n"));

    const dryRun = await client.callTool({ name: "import_recruiters", arguments: { sourcePath: csvPath, dryRun: true } });
    expect(dryRun.structuredContent).toMatchObject({ dryRun: true, wouldImport: 2, imported: 0 });
    expect(dryRun.structuredContent.rejected).toHaveLength(1);

    const imported = await client.callTool({ name: "import_recruiters", arguments: { sourcePath: csvPath } });
    expect(imported.structuredContent).toMatchObject({ imported: 2, invalidEmailFormatCount: 1 });
    expect(imported.structuredContent.note).toContain("do not verify");

    const filtered = await client.callTool({ name: "filter_recruiters", arguments: { company: "Acme" } });
    expect(filtered.structuredContent.total).toBe(2);
    const asha = filtered.structuredContent.recruiters.find((recruiter) => recruiter.email === "asha@acme.example");

    const validation = await client.callTool({ name: "validate_contacts", arguments: { recruiterIds: [asha.id] } });
    expect(validation.structuredContent.contacts[0]).toMatchObject({
      emailFormatValid: true,
      emailVerification: "format-only; deliverability is not verified",
    });

    const updated = await client.callTool({
      name: "update_recruiter",
      arguments: { id: asha.id, outreachStatus: "contacted" },
    });
    expect(updated.structuredContent.outreachStatus).toBe("contacted");

    const deleted = await client.callTool({
      name: "delete_recruiter",
      arguments: { id: asha.id, confirmDelete: true },
    });
    expect(deleted.structuredContent).toEqual({ deleted: true, id: asha.id });

    await client.close();
    await server.close();
    await server.closeDatabase();
  });

  it("prepares client-side email generation and manages unsent drafts", async () => {
    const { server, client } = await createTestApplication();
    const recruiter = await client.callTool({
      name: "create_recruiter",
      arguments: {
        name: "Maya Rao",
        email: "maya@acme.example",
        company: "Acme Labs",
        designation: "Engineering Recruiter",
        jobRole: "SDE Intern",
        publicProfessionalInfo: "Hiring for the platform engineering team.",
      },
    });

    const brief = await client.callTool({
      name: "generate_email",
      arguments: {
        recruiterId: recruiter.structuredContent.id,
        template: "sde_intern",
        companyInformation: "Acme's public internship page highlights platform engineering.",
      },
    });
    expect(brief.structuredContent).toMatchObject({
      mode: "client-side AI writing required",
      recruiter: { name: "Maya Rao", company: "Acme Labs" },
    });
    expect(brief.structuredContent.instructions.join(" ")).toContain("Do not call a paid AI API");

    const body = Array.from({ length: 110 }, (_, index) => `word${index + 1}`).join(" ");
    const saved = await client.callTool({
      name: "save_email_draft",
      arguments: {
        recruiterId: recruiter.structuredContent.id,
        template: "sde_intern",
        subject: "Interest in SDE internship opportunities at Acme Labs",
        body,
      },
    });
    expect(saved.structuredContent).toMatchObject({ status: "draft", wordCount: 110 });

    const drafts = await client.callTool({ name: "get_email_drafts", arguments: { recruiterId: recruiter.structuredContent.id } });
    expect(drafts.structuredContent.total).toBe(1);

    const updated = await client.callTool({
      name: "update_email_draft",
      arguments: { id: saved.structuredContent.id, subject: "SDE Intern inquiry — Acme Labs" },
    });
    expect(updated.structuredContent.subject).toBe("SDE Intern inquiry — Acme Labs");

    const deleted = await client.callTool({
      name: "delete_email_draft",
      arguments: { id: saved.structuredContent.id, confirmDelete: true },
    });
    expect(deleted.structuredContent).toEqual({ deleted: true, id: saved.structuredContent.id });

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
