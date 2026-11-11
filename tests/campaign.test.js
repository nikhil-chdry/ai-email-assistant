import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createMcpServer } from "../src/mcp/server.js";
import { encryptToken } from "../src/utils/crypto.js";

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
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-email-campaign-test-"));
  temporaryDirectories.push(temporaryDirectory);

  const encryptionKey = "test-encryption-key-for-phase-7-campaigns";
  const server = await createMcpServer({
    databasePath: path.join(temporaryDirectory, "test.sqlite"),
    uploadsDirectory: path.join(temporaryDirectory, "uploads"),
    encryptionKey,
    clientId: "mock-client-id",
    clientSecret: "mock-client-secret",
    fetchFn,
    delayMultiplier: 0, // Zero delay for instant test execution
  });

  const client = new Client({ name: "campaign-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return { server, client, temporaryDirectory, encryptionKey };
}

function seedConnectedGmail(server, encryptionKey, email = "candidate.sender@gmail.com") {
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

describe("Outreach Campaign Lifecycle (Phase 7)", () => {
  it("creates a campaign, deduplicates recruiters, and links email draft", async () => {
    const { server, client, encryptionKey } = await createTestApplication();
    seedConnectedGmail(server, encryptionKey);

    const r1 = await client.callTool({
      name: "create_recruiter",
      arguments: { name: "Aria Stark", email: "aria@winter.example", company: "Winter Inc" },
    });
    const r2 = await client.callTool({
      name: "create_recruiter",
      arguments: { name: "Duplicate Aria", email: "ARIA@winter.example", company: "Winter Inc" },
    });
    const r3 = await client.callTool({
      name: "create_recruiter",
      arguments: { name: "Jon Snow", email: "jon@wall.example", company: "Night's Watch" },
    });

    const draft = await client.callTool({
      name: "save_email_draft",
      arguments: {
        recruiterId: r1.structuredContent.id,
        template: "sde_intern",
        subject: "Summer 2027 SDE Internship Opportunities",
        body: "Hello, I am writing to express my interest in joining your engineering team as a software engineering intern.",
      },
    });

    const campaignResult = await client.callTool({
      name: "create_campaign",
      arguments: {
        name: "Q1 SDE Outreach",
        description: "Targeting engineering recruiters for SDE internships",
        emailDraftId: draft.structuredContent.id,
        recruiterIds: [r1.structuredContent.id, r3.structuredContent.id],
        attachActiveResume: false,
        batchSize: 5,
        delaySecondsBetweenEmails: 1,
      },
    });

    expect(campaignResult.structuredContent).toMatchObject({
      name: "Q1 SDE Outreach",
      status: "draft",
      version: 1,
      total_recipients: 2,
    });

    const preview = await client.callTool({
      name: "preview_campaign",
      arguments: { campaignId: campaignResult.structuredContent.id },
    });

    expect(preview.structuredContent).toMatchObject({
      name: "Q1 SDE Outreach",
      status: "draft",
      recipientsSummary: {
        total: 2,
        pending: 2,
        sent: 0,
      },
      checks: {
        gmailConnected: true,
      },
    });

    await client.close();
    await server.close();
    await server.closeDatabase();
  });

  it("authorizes immutable campaign approval and rejects unauthorized modifications", async () => {
    const { server, client, encryptionKey } = await createTestApplication();
    seedConnectedGmail(server, encryptionKey);

    const r1 = await client.callTool({
      name: "create_recruiter",
      arguments: { name: "Elena Vance", email: "elena@tech.example", company: "Tech Labs" },
    });

    const draft = await client.callTool({
      name: "save_email_draft",
      arguments: {
        recruiterId: r1.structuredContent.id,
        template: "backend_developer",
        subject: "Backend Role Inquiry",
        body: "Hello Elena, I am inquiring about backend engineering roles at Tech Labs.",
      },
    });

    const campaign = await client.callTool({
      name: "create_campaign",
      arguments: {
        name: "Backend Campaign",
        emailDraftId: draft.structuredContent.id,
      },
    });
    const campaignId = campaign.structuredContent.id;

    // Unconfirmed approval returns preview
    const unconfirmed = await client.callTool({
      name: "approve_campaign",
      arguments: { campaignId, confirmApproval: false },
    });
    expect(unconfirmed.structuredContent.requiresConfirmation).toBe(true);

    // Confirmed approval computes approval hash
    const approved = await client.callTool({
      name: "approve_campaign",
      arguments: { campaignId, confirmApproval: true },
    });
    expect(approved.structuredContent).toMatchObject({
      approved: true,
      status: "approved",
      version: 1,
    });
    expect(approved.structuredContent.approvalHash).toHaveLength(64);

    // If an attacker or bug modifies the draft text after approval, hash mismatch is detected!
    await client.callTool({
      name: "update_email_draft",
      arguments: { id: draft.structuredContent.id, subject: "Modified Subject Without Reapproval" },
    });

    // Attempting to send modified draft must fail validation
    const sendAttempt = await client.callTool({
      name: "send_campaign",
      arguments: { campaignId, confirmSend: true },
    });
    expect(sendAttempt.isError).toBe(true);
    expect(sendAttempt.content[0].text).toContain("Campaign approval is invalid");

    await client.close();
    await server.close();
    await server.closeDatabase();
  });

  it("dispatches campaign batches, prevents duplicate sends, and respects suppression lists", async () => {
    const sentEmailsList = [];
    const fetchFn = async (url, options = {}) => {
      const parsedBody = JSON.parse(options.body);
      const decodedMime = Buffer.from(parsedBody.raw, "base64url").toString("utf8");
      sentEmailsList.push(decodedMime);

      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: `msg_campaign_${sentEmailsList.length}`,
          threadId: `th_campaign_${sentEmailsList.length}`,
        }),
      };
    };

    const { server, client, encryptionKey } = await createTestApplication({ fetchFn });
    seedConnectedGmail(server, encryptionKey);

    const r1 = await client.callTool({
      name: "create_recruiter",
      arguments: { name: "Bob Martin", email: "bob@clean.example", company: "Clean Code" },
    });
    const r2 = await client.callTool({
      name: "create_recruiter",
      arguments: { name: "Alice Suppressed", email: "alice@optout.example", company: "OptOut Corp" },
    });
    const r3 = await client.callTool({
      name: "create_recruiter",
      arguments: { name: "Charlie Day", email: "charlie@paddy.example", company: "Paddy's Pub" },
    });

    // Add Alice to suppression list
    await server.campaignService.addToSuppressionList({
      email: "alice@optout.example",
      reason: "Requested unsubscribed",
    });

    const draft = await client.callTool({
      name: "save_email_draft",
      arguments: {
        recruiterId: r1.structuredContent.id,
        template: "software_engineer",
        subject: "Software Engineer Inquiry",
        body: "Hello, I am interested in software engineering openings.",
      },
    });

    const campaign = await client.callTool({
      name: "create_campaign",
      arguments: {
        name: "Engineering Outreach Batch",
        emailDraftId: draft.structuredContent.id,
        recruiterIds: [r1.structuredContent.id, r2.structuredContent.id, r3.structuredContent.id],
        batchSize: 10,
        delaySecondsBetweenEmails: 0,
      },
    });
    const campaignId = campaign.structuredContent.id;

    await client.callTool({
      name: "approve_campaign",
      arguments: { campaignId, confirmApproval: true },
    });

    // Send the campaign
    const sendResult = await client.callTool({
      name: "send_campaign",
      arguments: { campaignId, confirmSend: true },
    });

    expect(sendResult.isError).not.toBe(true);
    expect(sendResult.structuredContent.success).toBe(true);
    expect(sendResult.structuredContent.batchSummary).toMatchObject({
      sentInBatch: 2,      // Bob and Charlie sent
      skippedInBatch: 1,   // Alice skipped via suppression list
      remainingPending: 0,
    });
    expect(sendResult.structuredContent.status).toBe("completed");

    // Verify Gmail sent 2 emails only (Alice was NEVER dispatched to Gmail)
    expect(sentEmailsList).toHaveLength(2);
    expect(sentEmailsList.some((m) => m.includes("bob@clean.example"))).toBe(true);
    expect(sentEmailsList.some((m) => m.includes("charlie@paddy.example"))).toBe(true);
    expect(sentEmailsList.some((m) => m.includes("alice@optout.example"))).toBe(false);

    // Verify sent_emails table records
    const sentRows = server.campaignService.database.all(
      "SELECT * FROM sent_emails WHERE campaign_id = ?",
      [campaignId],
    );
    expect(sentRows).toHaveLength(2);
    expect(sentRows[0].send_type).toBe("campaign");

    // DUPLICATE SEND TEST: Attempting to send again must NOT re-send any email
    const reSendResult = await client.callTool({
      name: "send_campaign",
      arguments: { campaignId, confirmSend: true },
    });
    expect(reSendResult.isError).toBe(true);
    expect(reSendResult.content[0].text).toContain("Cannot send campaign in 'completed' status");
    expect(sentEmailsList).toHaveLength(2); // No new email sent

    // Verify Campaign Report
    const report = await client.callTool({
      name: "get_campaign_report",
      arguments: { campaignId },
    });

    expect(report.structuredContent.statistics).toMatchObject({
      totalRecipients: 3,
      sent: 2,
      skipped: 1,
      failed: 0,
      pending: 0,
      successRatePercent: 67,
    });

    await client.close();
    await server.close();
    await server.closeDatabase();
  });

  it("handles pause, resume, and stop campaign controls with confirmation", async () => {
    const fetchFn = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: "msg_ctrl", threadId: "th_ctrl" }),
    });

    const { server, client, encryptionKey } = await createTestApplication({ fetchFn });
    seedConnectedGmail(server, encryptionKey);

    const r1 = await client.callTool({
      name: "create_recruiter",
      arguments: { name: "Recruiter One", email: "r1@agency.example", company: "Agency" },
    });
    const r2 = await client.callTool({
      name: "create_recruiter",
      arguments: { name: "Recruiter Two", email: "r2@agency.example", company: "Agency" },
    });

    const draft = await client.callTool({
      name: "save_email_draft",
      arguments: {
        recruiterId: r1.structuredContent.id,
        template: "ai_engineer",
        subject: "AI Engineer Role",
        body: "Hello, inquiring about AI engineering positions.",
      },
    });

    const campaign = await client.callTool({
      name: "create_campaign",
      arguments: {
        name: "Control Test Campaign",
        emailDraftId: draft.structuredContent.id,
        recruiterIds: [r1.structuredContent.id, r2.structuredContent.id],
      },
    });
    const campaignId = campaign.structuredContent.id;

    await client.callTool({
      name: "approve_campaign",
      arguments: { campaignId, confirmApproval: true },
    });

    // Pause campaign
    const paused = await client.callTool({
      name: "pause_campaign",
      arguments: { campaignId },
    });
    expect(paused.structuredContent.status).toBe("paused");

    // Resume campaign
    const resumed = await client.callTool({
      name: "resume_campaign",
      arguments: { campaignId },
    });
    expect(resumed.structuredContent.status).toBe("approved");

    // Stop campaign requires confirmation
    const stopUnconfirmed = await client.callTool({
      name: "stop_campaign",
      arguments: { campaignId, confirmStop: false },
    });
    expect(stopUnconfirmed.structuredContent.requiresConfirmation).toBe(true);

    // Stop confirmed
    const stopConfirmed = await client.callTool({
      name: "stop_campaign",
      arguments: { campaignId, confirmStop: true },
    });
    expect(stopConfirmed.structuredContent.status).toBe("stopped");

    // Report reflects stopped status and skipped recipients
    const report = await client.callTool({
      name: "get_campaign_report",
      arguments: { campaignId },
    });
    expect(report.structuredContent.campaign.status).toBe("stopped");
    expect(report.structuredContent.statistics.skipped).toBe(2);

    await client.close();
    await server.close();
    await server.closeDatabase();
  });
});
