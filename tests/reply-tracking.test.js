import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createMcpServer } from "../src/mcp/server.js";
import { encryptToken } from "../src/utils/crypto.js";

const temporaryDirectories = [];

async function createTestApplication({ fetchFn } = {}) {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-email-reply-test-"));
  temporaryDirectories.push(temporaryDirectory);

  const encryptionKey = "test-encryption-key-for-phase-8-replies";
  const server = await createMcpServer({
    databasePath: path.join(temporaryDirectory, "test.sqlite"),
    uploadsDirectory: path.join(temporaryDirectory, "uploads"),
    encryptionKey,
    clientId: "mock-client-id",
    clientSecret: "mock-client-secret",
    fetchFn,
  });

  const client = new Client({ name: "reply-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return { server, client, temporaryDirectory, encryptionKey };
}

function seedConnectedGmail(server, encryptionKey, email = "candidate.nikhil@gmail.com") {
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

describe("Reply Tracking & Follow-up Management (Phase 8)", () => {
  it("detects replies from Gmail threads, updates status, and auto-cancels scheduled follow-ups", async () => {
    const threadMockData = {
      id: "thread_12345",
      messages: [
        {
          id: "msg_outreach_1",
          threadId: "thread_12345",
          snippet: "I am interested in software engineering roles...",
          payload: {
            headers: [
              { name: "From", value: "candidate.nikhil@gmail.com" },
              { name: "Subject", value: "SDE Opportunities" },
              { name: "Date", value: "Mon, 10 Nov 2026 10:00:00 GMT" },
            ],
          },
        },
        {
          id: "msg_recruiter_reply_1",
          threadId: "thread_12345",
          snippet: "Thanks for reaching out! We'd love to schedule a screening call.",
          payload: {
            headers: [
              { name: "From", value: '"Sarah Recruiter" <sarah@acme.example>' },
              { name: "Subject", value: "Re: SDE Opportunities" },
              { name: "Date", value: "Tue, 11 Nov 2026 09:30:00 GMT" },
            ],
          },
        },
      ],
    };

    const fetchFn = async (url) => {
      const urlStr = url.toString();
      if (urlStr.includes("gmail.googleapis.com/gmail/v1/users/me/threads/thread_12345")) {
        return {
          ok: true,
          status: 200,
          json: async () => threadMockData,
        };
      }
      throw new Error(`Unexpected fetch URL: ${urlStr}`);
    };

    const { server, client, encryptionKey } = await createTestApplication({ fetchFn });
    seedConnectedGmail(server, encryptionKey, "candidate.nikhil@gmail.com");

    const recruiter = await client.callTool({
      name: "create_recruiter",
      arguments: { name: "Sarah Recruiter", email: "sarah@acme.example", company: "Acme Corp" },
    });
    const recruiterId = recruiter.structuredContent.id;

    // Seed a sent outreach email in sent_emails
    const now = new Date().toISOString();
    server.replyTrackingService.database.run(
      `INSERT INTO sent_emails (
        recipient_email, recipient_name, recruiter_id, subject, body_text,
        gmail_message_id, gmail_thread_id, send_type, status, sent_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'campaign', 'sent', ?)`,
      [
        "sarah@acme.example",
        "Sarah Recruiter",
        recruiterId,
        "SDE Opportunities",
        "Initial outreach body",
        "msg_outreach_1",
        "thread_12345",
        now,
      ],
    );

    // Schedule a follow-up for Sarah
    await client.callTool({
      name: "schedule_followups",
      arguments: { recruiterIds: [recruiterId], daysDelay: 4 },
    });

    const pendingBefore = await client.callTool({ name: "get_pending_followups", arguments: {} });
    expect(pendingBefore.structuredContent.totalPending).toBe(1);

    // Call check_replies tool
    const checkResult = await client.callTool({ name: "check_replies", arguments: {} });

    expect(checkResult.structuredContent.checkedThreads).toBe(1);
    expect(checkResult.structuredContent.newRepliesFound).toBe(1);

    const reply = checkResult.structuredContent.replies[0];
    expect(reply).toMatchObject({
      recruiterId,
      recipientEmail: "sarah@acme.example",
      subject: "Re: SDE Opportunities",
      snippet: "Thanks for reaching out! We'd love to schedule a screening call.",
      fromHeader: '"Sarah Recruiter" <sarah@acme.example>',
    });

    // Verify recruiter outreach_status updated to 'replied'
    const updatedRecruiter = server.replyTrackingService.database.get(
      "SELECT outreach_status FROM recruiters WHERE id = ?",
      [recruiterId],
    );
    expect(updatedRecruiter.outreach_status).toBe("replied");

    // AUTOMATIC CANCELLATION: verify pending follow-up was automatically cancelled
    const followupRow = server.replyTrackingService.database.get(
      "SELECT status, cancel_reason FROM scheduled_followups WHERE recruiter_id = ?",
      [recruiterId],
    );
    expect(followupRow).toMatchObject({
      status: "cancelled",
      cancel_reason: "reply_received",
    });

    const pendingAfter = await client.callTool({ name: "get_pending_followups", arguments: {} });
    expect(pendingAfter.structuredContent.totalPending).toBe(0);

    await client.close();
    await server.close();
    await server.closeDatabase();
  });

  it("classifies replies and stores category and reasoning", async () => {
    const { server, client, encryptionKey } = await createTestApplication();
    seedConnectedGmail(server, encryptionKey);

    const r = await client.callTool({
      name: "create_recruiter",
      arguments: { name: "Tom Holland", email: "tom@marvel.example", company: "Marvel" },
    });
    const recruiterId = r.structuredContent.id;

    const now = new Date().toISOString();
    const insertedReply = server.replyTrackingService.database.run(
      `INSERT INTO recruiter_replies (
        recruiter_id, recipient_email, gmail_message_id, gmail_thread_id,
        subject, snippet, from_header, classification, received_at, created_at, updated_at
      ) VALUES (?, ?, 'msg_tom_1', 'th_tom_1', 'Re: SDE Role', 'Can you do an interview this Thursday?', 'tom@marvel.example', 'unclassified', ?, ?, ?)`,
      [recruiterId, "tom@marvel.example", now, now, now],
    );
    const replyId = insertedReply.lastInsertRowid;

    const classifyResult = await client.callTool({
      name: "classify_reply",
      arguments: {
        replyId,
        classification: "interview_invitation",
        reason: "Recruiter requested an interview date for Thursday.",
      },
    });

    expect(classifyResult.structuredContent).toMatchObject({
      replyId,
      classification: "interview_invitation",
      reason: "Recruiter requested an interview date for Thursday.",
    });

    const dbRow = server.replyTrackingService.database.get(
      "SELECT classification, classification_reason FROM recruiter_replies WHERE id = ?",
      [replyId],
    );
    expect(dbRow.classification).toBe("interview_invitation");
    expect(dbRow.classification_reason).toBe("Recruiter requested an interview date for Thursday.");

    await client.close();
    await server.close();
    await server.closeDatabase();
  });

  it("refuses to generate automated follow-up when recruiter has already replied", async () => {
    const { server, client, encryptionKey } = await createTestApplication();
    seedConnectedGmail(server, encryptionKey);

    const r = await client.callTool({
      name: "create_recruiter",
      arguments: { name: "Diana Prince", email: "diana@themyscira.example", company: "Amazonian Tech" },
    });
    const recruiterId = r.structuredContent.id;

    const now = new Date().toISOString();
    server.replyTrackingService.database.run(
      `INSERT INTO recruiter_replies (
        recruiter_id, recipient_email, gmail_message_id, gmail_thread_id,
        subject, snippet, from_header, classification, received_at, created_at, updated_at
      ) VALUES (?, ?, 'msg_diana_1', 'th_diana_1', 'Re: Internship', 'We would love to interview you for the internship role.', 'diana@themyscira.example', 'interview_invitation', ?, ?, ?)`,
      [recruiterId, "diana@themyscira.example", now, now, now],
    );

    // Attempting to generate follow-up must be rejected!
    const followupAttempt = await client.callTool({
      name: "generate_followup",
      arguments: { recruiterId },
    });

    expect(followupAttempt.isError).toBe(true);
    expect(followupAttempt.content[0].text).toContain("interview invitation");
    expect(followupAttempt.content[0].text).toContain("Review and respond personally");

    await client.close();
    await server.close();
    await server.closeDatabase();
  });

  it("generates truthful follow-up draft brief when follow-up is due and unreplied", async () => {
    const { server, client, encryptionKey } = await createTestApplication();
    seedConnectedGmail(server, encryptionKey);

    const r = await client.callTool({
      name: "create_recruiter",
      arguments: { name: "Bruce Wayne", email: "bruce@wayne.example", company: "Wayne Enterprises", jobRole: "SDE Intern" },
    });
    const recruiterId = r.structuredContent.id;

    const pastDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const sentEmail = server.replyTrackingService.database.run(
      `INSERT INTO sent_emails (
        recipient_email, recipient_name, recruiter_id, subject, body_text,
        gmail_message_id, gmail_thread_id, send_type, status, sent_at
      ) VALUES (?, ?, ?, 'SDE Opportunities at Wayne Tech', 'Initial outreach body', 'msg_bruce_0', 'th_bruce_0', 'campaign', 'sent', ?)`,
      ["bruce@wayne.example", "Bruce Wayne", recruiterId, pastDate],
    );

    const scheduleRes = await client.callTool({
      name: "schedule_followups",
      arguments: { recruiterIds: [recruiterId], daysDelay: 4 },
    });
    expect(scheduleRes.structuredContent.scheduledCount).toBe(1);

    const pending = await client.callTool({
      name: "get_pending_followups",
      arguments: { dueOnly: true },
    });
    expect(pending.structuredContent.dueCount).toBe(1);
    expect(pending.structuredContent.processLimitationNote).toContain("operate locally");

    const brief = await client.callTool({
      name: "generate_followup",
      arguments: { followupId: pending.structuredContent.followups[0].id },
    });

    expect(brief.isError).not.toBe(true);
    expect(brief.structuredContent).toMatchObject({
      mode: "client-side AI follow-up draft brief",
      recruiter: {
        name: "Bruce Wayne",
        company: "Wayne Enterprises",
        email: "bruce@wayne.example",
      },
      originalOutreach: {
        subject: "SDE Opportunities at Wayne Tech",
      },
      suggestedSubject: "Re: SDE Opportunities at Wayne Tech",
    });
    expect(brief.structuredContent.constraints.join(" ")).toContain("50 to 80 words");

    const updatedFollowup = server.replyTrackingService.database.get(
      "SELECT status FROM scheduled_followups WHERE id = ?",
      [pending.structuredContent.followups[0].id],
    );
    expect(updatedFollowup.status).toBe("draft_generated");

    await client.close();
    await server.close();
    await server.closeDatabase();
  });
});
