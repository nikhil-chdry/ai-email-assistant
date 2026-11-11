import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createMcpServer } from "../src/mcp/server.js";
import { decryptToken, encryptToken } from "../src/utils/crypto.js";

const temporaryDirectories = [];

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

async function createTestApplication({ fetchFn } = {}) {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-email-hardening-test-"));
  temporaryDirectories.push(temporaryDirectory);

  const encryptionKey = "test-encryption-key-for-phase-9-hardening";
  const server = await createMcpServer({
    databasePath: path.join(temporaryDirectory, "test.sqlite"),
    uploadsDirectory: path.join(temporaryDirectory, "uploads"),
    encryptionKey,
    clientId: "mock-client-id",
    clientSecret: "mock-client-secret",
    fetchFn,
    delayMultiplier: 0,
  });

  const client = new Client({ name: "hardening-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return { server, client, temporaryDirectory, encryptionKey };
}

function seedConnectedGmail(server, encryptionKey, email = "verified.sender@gmail.com") {
  const now = new Date();
  const expiryDate = Date.now() + 3600 * 1000;
  const encryptedAccess = encryptToken("ya29.valid-mock-access-token", encryptionKey);
  const encryptedRefresh = encryptToken("1//mock-refresh-token", encryptionKey);

  server.gmailOAuthService.database.run(
    `INSERT OR REPLACE INTO gmail_tokens (
      id, email, encrypted_access_token, encrypted_refresh_token,
      token_type, scope, expiry_date, created_at, updated_at
    ) VALUES (1, ?, ?, ?, 'Bearer', 'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly', ?, ?, ?)`,
    [email, encryptedAccess, encryptedRefresh, expiryDate, now.toISOString(), now.toISOString()],
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("Security Hardening & Boundary Verification (Phase 9)", () => {
  it("strictly protects against path traversal and unauthorized file extension attacks in resume upload", async () => {
    const { server, client, temporaryDirectory } = await createTestApplication();

    // 1. Non-PDF extension must be rejected
    const textFilePath = path.join(temporaryDirectory, "malicious.txt");
    await fs.writeFile(textFilePath, "some plain text");

    const nonPdfResult = await client.callTool({
      name: "upload_resume",
      arguments: { sourcePath: textFilePath },
    });
    expect(nonPdfResult.isError).toBe(true);
    expect(nonPdfResult.content[0].text).toContain("must be PDF files");

    // 2. Fake PDF (PDF extension with invalid content) must be rejected
    const fakePdfPath = path.join(temporaryDirectory, "fake.pdf");
    await fs.writeFile(fakePdfPath, "NOT A VALID PDF FILE HEADER");

    const fakePdfResult = await client.callTool({
      name: "upload_resume",
      arguments: { sourcePath: fakePdfPath },
    });
    expect(fakePdfResult.isError).toBe(true);
    expect(fakePdfResult.content[0].text).toContain("not a valid PDF");

    await client.close();
    await server.close();
    await server.closeDatabase();
  });

  it("enforces path traversal boundary in getActiveResumeFile storage retrieval", async () => {
    const { server, client, temporaryDirectory } = await createTestApplication();

    // Seed a resume row pointing outside the uploads directory (simulating DB tampering attack)
    const outsideFile = path.join(temporaryDirectory, "outside.pdf");
    await fs.writeFile(outsideFile, createMinimalPdf("Outside resume"));

    server.profileService.database.run(
      `INSERT INTO resumes (id, original_filename, stored_filename, mime_type, size_bytes, sha256, extracted_text, uploaded_at)
       VALUES (999, 'outside.pdf', '../../outside.pdf', 'application/pdf', 100, 'hash999', 'sample text', ?)`,
      [new Date().toISOString()],
    );
    server.profileService.database.run("UPDATE candidate_profiles SET resume_id = 999 WHERE id = 1");

    await expect(server.profileService.getActiveResumeFile()).rejects.toThrow(
      /Invalid resume storage path detected/,
    );

    await client.close();
    await server.close();
    await server.closeDatabase();
  });

  it("enforces cryptographic authentication tags and rejects ciphertext alteration", () => {
    const key = "super-secret-key-for-tampering-test";
    const sensitive = "sensitive_refresh_token_12345";
    const encrypted = encryptToken(sensitive, key);

    const envelope = JSON.parse(encrypted);

    // Tamper with data byte
    const tamperedData = (parseInt(envelope.data[0], 16) ^ 1).toString(16) + envelope.data.slice(1);
    expect(() =>
      decryptToken(JSON.stringify({ ...envelope, data: tamperedData }), key),
    ).toThrow(/authentication failed/);

    // Tamper with auth tag
    const tamperedTag = (parseInt(envelope.tag[0], 16) ^ 1).toString(16) + envelope.tag.slice(1);
    expect(() =>
      decryptToken(JSON.stringify({ ...envelope, tag: tamperedTag }), key),
    ).toThrow(/authentication failed/);

    // Decrypting with wrong key fails
    expect(() => decryptToken(encrypted, "wrong-key")).toThrow(/authentication failed/);
  });

  it("enforces explicit confirmation across all destructive actions", async () => {
    const { server, client, encryptionKey } = await createTestApplication();
    seedConnectedGmail(server, encryptionKey);

    // 1. Recruiter deletion requires confirmDelete: true
    const recruiter = await client.callTool({
      name: "create_recruiter",
      arguments: { name: "Test Recruiter", email: "recruiter@delete.example" },
    });
    const recruiterId = recruiter.structuredContent.id;

    const unconfirmedRecruiterDel = await client.callTool({
      name: "delete_recruiter",
      arguments: { id: recruiterId, confirmDelete: false },
    });
    expect(unconfirmedRecruiterDel.isError).toBe(true);

    // 2. Email draft deletion requires confirmDelete: true
    const draft = await client.callTool({
      name: "save_email_draft",
      arguments: {
        recruiterId,
        template: "sde_intern",
        subject: "Draft to Delete",
        body: "Sample draft body",
      },
    });
    const draftId = draft.structuredContent.id;

    const unconfirmedDraftDel = await client.callTool({
      name: "delete_email_draft",
      arguments: { id: draftId, confirmDelete: false },
    });
    expect(unconfirmedDraftDel.isError).toBe(true);

    // 3. Gmail disconnect requires confirmDisconnect: true
    const unconfirmedDisconnect = await client.callTool({
      name: "connect_gmail",
      arguments: { disconnect: true, confirmDisconnect: false },
    });
    expect(unconfirmedDisconnect.structuredContent.disconnected).toBe(false);

    // 4. Campaign stop requires confirmStop: true
    const campaign = await client.callTool({
      name: "create_campaign",
      arguments: { name: "Campaign to Stop", emailDraftId: draftId },
    });
    const campaignId = campaign.structuredContent.id;

    const unconfirmedStop = await client.callTool({
      name: "stop_campaign",
      arguments: { campaignId, confirmStop: false },
    });
    expect(unconfirmedStop.structuredContent.requiresConfirmation).toBe(true);

    // 5. Single test email requires confirmSend: true
    const unconfirmedSend = await client.callTool({
      name: "send_test_email",
      arguments: { recipientEmail: "test@example.com", subject: "Test", bodyText: "Text", confirmSend: false },
    });
    expect(unconfirmedSend.structuredContent.requiresConfirmation).toBe(true);

    // 6. Campaign send requires confirmSend: true
    const unconfirmedCampaignSend = await client.callTool({
      name: "send_campaign",
      arguments: { campaignId, confirmSend: false },
    });
    expect(unconfirmedCampaignSend.structuredContent.requiresConfirmation).toBe(true);

    await client.close();
    await server.close();
    await server.closeDatabase();
  });

  it("strictly enforces Zod schema rejection on unrecognized extra properties", async () => {
    const { server, client } = await createTestApplication();

    // Calling create_recruiter with arbitrary injected properties must be rejected by Zod
    const injectedCall = await client.callTool({
      name: "create_recruiter",
      arguments: {
        name: "Valid Name",
        email: "valid@example.com",
        maliciousExtraProperty: "DROP TABLE users;",
      },
    });

    expect(injectedCall.isError).toBe(true);
    expect(injectedCall.content[0].text).toMatch(/unrecognized/i);

    await client.close();
    await server.close();
    await server.closeDatabase();
  });

  it("verifies activity logging captures operational metadata without recording secret values", async () => {
    const { server, client, encryptionKey } = await createTestApplication();
    seedConnectedGmail(server, encryptionKey);

    const r = await client.callTool({
      name: "create_recruiter",
      arguments: { name: "Audit Recruiter", email: "audit@company.example" },
    });
    const draft = await client.callTool({
      name: "save_email_draft",
      arguments: {
        recruiterId: r.structuredContent.id,
        template: "full_stack_developer",
        subject: "Audit Subject",
        body: "Audit Body",
      },
    });

    const campaign = await client.callTool({
      name: "create_campaign",
      arguments: { name: "Audit Campaign", emailDraftId: draft.structuredContent.id },
    });

    await client.callTool({
      name: "approve_campaign",
      arguments: { campaignId: campaign.structuredContent.id, confirmApproval: true },
    });

    const logs = server.database.all("SELECT * FROM activity_logs ORDER BY id ASC");
    expect(logs.length).toBeGreaterThan(0);

    for (const log of logs) {
      // Must not contain OAuth tokens or encryption keys
      expect(log.details_json).not.toContain("ya29.");
      expect(log.details_json).not.toContain("mock-refresh-token");
      expect(log.details_json).not.toContain(encryptionKey);
    }

    await client.close();
    await server.close();
    await server.closeDatabase();
  });

  it("validates recruiter CSV import boundaries and rejects non-csv files and missing headers", async () => {
    const { server, client, temporaryDirectory } = await createTestApplication();

    // 1. Non-CSV file extension must be rejected
    const nonCsvFile = path.join(temporaryDirectory, "recruiters.json");
    await fs.writeFile(nonCsvFile, JSON.stringify([{ name: "Test", email: "test@example.com" }]));

    const nonCsvResult = await client.callTool({
      name: "import_recruiters",
      arguments: { sourcePath: nonCsvFile },
    });
    expect(nonCsvResult.isError).toBe(true);
    expect(nonCsvResult.content[0].text).toContain("must be CSV files");

    // 2. CSV missing required header must be rejected
    const invalidHeaderCsv = path.join(temporaryDirectory, "invalid_headers.csv");
    await fs.writeFile(invalidHeaderCsv, "first_name,last_name\nJohn,Doe\n");

    const invalidResult = await client.callTool({
      name: "import_recruiters",
      arguments: { sourcePath: invalidHeaderCsv },
    });
    expect(invalidResult.isError).toBe(true);
    expect(invalidResult.content[0].text).toContain("missing the required 'name' column");

    await client.close();
    await server.close();
    await server.closeDatabase();
  });

  it("strictly enforces suppression list and excludes suppressed recruiters from campaign dispatch", async () => {
    const sentEmails = [];
    const fetchFn = async (url, options = {}) => {
      const parsed = JSON.parse(options.body);
      sentEmails.push(Buffer.from(parsed.raw, "base64url").toString("utf8"));
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: `msg_${sentEmails.length}`, threadId: `th_${sentEmails.length}` }),
      };
    };

    const { server, client, encryptionKey } = await createTestApplication({ fetchFn });
    seedConnectedGmail(server, encryptionKey);

    const rAllowed = await client.callTool({
      name: "create_recruiter",
      arguments: { name: "Allowed Recruiter", email: "allowed@agency.example" },
    });
    const rSuppressed = await client.callTool({
      name: "create_recruiter",
      arguments: { name: "Do Not Email", email: "suppressed@agency.example" },
    });

    // Add to suppression list
    await server.campaignService.addToSuppressionList({
      email: "suppressed@agency.example",
      reason: "User unsubscribed / requested suppression",
    });

    const isSuppressed = server.campaignService.isSuppressed("suppressed@agency.example");
    expect(isSuppressed).toBe(true);

    const draft = await client.callTool({
      name: "save_email_draft",
      arguments: {
        recruiterId: rAllowed.structuredContent.id,
        template: "ai_engineer",
        subject: "AI Role",
        body: "Hello, reaching out regarding AI engineering.",
      },
    });

    const campaign = await client.callTool({
      name: "create_campaign",
      arguments: {
        name: "Suppression Verification Campaign",
        emailDraftId: draft.structuredContent.id,
        recruiterIds: [rAllowed.structuredContent.id, rSuppressed.structuredContent.id],
      },
    });

    // Preview should note the suppressed contact
    const preview = await client.callTool({
      name: "preview_campaign",
      arguments: { campaignId: campaign.structuredContent.id },
    });
    expect(preview.structuredContent.recipientsSummary.currentlySuppressed).toBe(1);

    await client.callTool({
      name: "approve_campaign",
      arguments: { campaignId: campaign.structuredContent.id, confirmApproval: true },
    });

    // Dispatch
    const sendResult = await client.callTool({
      name: "send_campaign",
      arguments: { campaignId: campaign.structuredContent.id, confirmSend: true },
    });

    expect(sendResult.structuredContent.batchSummary.sentInBatch).toBe(1);
    expect(sendResult.structuredContent.batchSummary.skippedInBatch).toBe(1);
    expect(sentEmails.some((e) => e.includes("suppressed@agency.example"))).toBe(false);

    await client.close();
    await server.close();
    await server.closeDatabase();
  });
});
