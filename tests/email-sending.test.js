import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createMcpServer } from "../src/mcp/server.js";
import {
  buildMimeMessage,
  encodeMimeWord,
  encodeRawForGmail,
  formatAddress,
  wrapBase64,
} from "../src/utils/mime-builder.js";
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
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-email-send-test-"));
  temporaryDirectories.push(temporaryDirectory);

  const encryptionKey = "test-encryption-key-for-phase-6-send";
  const server = await createMcpServer({
    databasePath: path.join(temporaryDirectory, "test.sqlite"),
    uploadsDirectory: path.join(temporaryDirectory, "uploads"),
    encryptionKey,
    clientId: "mock-client-id",
    clientSecret: "mock-client-secret",
    fetchFn,
  });

  const client = new Client({ name: "send-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return { server, client, temporaryDirectory, encryptionKey };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("MIME Message Construction", () => {
  it("encodes MIME headers and addresses correctly", () => {
    expect(encodeMimeWord("Simple ASCII")).toBe("Simple ASCII");
    expect(encodeMimeWord("Subject with unicode: Résumé")).toContain("=?UTF-8?B?");

    expect(formatAddress("Nikhil Sunda", "nikhil@example.com")).toBe("Nikhil Sunda <nikhil@example.com>");
    expect(formatAddress("", "nikhil@example.com")).toBe("nikhil@example.com");
  });

  it("wraps base64 strings into 76-character lines", () => {
    const longString = "A".repeat(200);
    const wrapped = wrapBase64(longString, 76);
    const lines = wrapped.split("\r\n");
    expect(lines[0]).toHaveLength(76);
    expect(lines[1]).toHaveLength(76);
    expect(lines[2]).toHaveLength(48);
  });

  it("constructs RFC 2822 plain-text email with correct headers", () => {
    const mime = buildMimeMessage({
      fromEmail: "sender@gmail.com",
      fromName: "Sender Name",
      toEmail: "recipient@example.com",
      toName: "Recipient Name",
      subject: "Hello World",
      bodyText: "This is a plain text body.",
    });

    expect(mime).toContain("From: Sender Name <sender@gmail.com>");
    expect(mime).toContain("To: Recipient Name <recipient@example.com>");
    expect(mime).toContain("Subject: Hello World");
    expect(mime).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(mime).toContain("MIME-Version: 1.0");

    const raw = encodeRawForGmail(mime);
    expect(raw).not.toContain("+");
    expect(raw).not.toContain("/");
    expect(raw).not.toContain("=");
  });

  it("constructs multipart/alternative email when HTML is included", () => {
    const mime = buildMimeMessage({
      fromEmail: "sender@gmail.com",
      toEmail: "recipient@example.com",
      subject: "HTML Outreach",
      bodyText: "Plain text version",
      bodyHtml: "<p>HTML version</p>",
    });

    expect(mime).toContain("Content-Type: multipart/alternative; boundary=");
    expect(mime).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(mime).toContain('Content-Type: text/html; charset="UTF-8"');
  });

  it("constructs multipart/mixed email with PDF attachment", () => {
    const pdfContent = Buffer.from("%PDF-1.4 mock pdf content");
    const mime = buildMimeMessage({
      fromEmail: "sender@gmail.com",
      toEmail: "recipient@example.com",
      subject: "Outreach with Resume",
      bodyText: "Please see attached resume.",
      bodyHtml: "<p>Please see attached resume.</p>",
      attachment: {
        filename: "Nikhil-Resume.pdf",
        content: pdfContent,
        mimeType: "application/pdf",
      },
    });

    expect(mime).toContain("Content-Type: multipart/mixed; boundary=");
    expect(mime).toContain("Content-Type: multipart/alternative; boundary=");
    expect(mime).toContain('Content-Type: application/pdf; name="Nikhil-Resume.pdf"');
    expect(mime).toContain('Content-Disposition: attachment; filename="Nikhil-Resume.pdf"');
    expect(mime).toContain("Content-Transfer-Encoding: base64");
    expect(mime).toContain(pdfContent.toString("base64"));
  });
});

describe("Single Email Sending & send_test_email Tool", () => {
  function seedConnectedGmail(server, encryptionKey, email = "nikhil.test@gmail.com") {
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

  it("requires explicit confirmSend: true to send test email and returns preview when omitted", async () => {
    const { server, client, encryptionKey } = await createTestApplication();
    seedConnectedGmail(server, encryptionKey);

    const preview = await client.callTool({
      name: "send_test_email",
      arguments: {
        recipientEmail: "test.recruiter@example.com",
        subject: "Test Outreach Inquiry",
        bodyText: "This is a test outreach message.",
        confirmSend: false,
      },
    });

    expect(preview.structuredContent).toMatchObject({
      confirmed: false,
      requiresConfirmation: true,
      preview: {
        recipientEmail: "test.recruiter@example.com",
        subject: "Test Outreach Inquiry",
        hasDraft: false,
        attachActiveResume: false,
      },
    });

    await client.close();
    await server.close();
    await server.closeDatabase();
  });

  it("fails safely if Gmail is not connected", async () => {
    const { server, client } = await createTestApplication();

    const response = await client.callTool({
      name: "send_test_email",
      arguments: {
        recipientEmail: "test@example.com",
        subject: "Test",
        bodyText: "Test body",
        confirmSend: true,
      },
    });
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain("Gmail is not connected");

    await client.close();
    await server.close();
    await server.closeDatabase();
  });

  it("sends single test email via mocked Gmail API, records message ID, and stores delivery result", async () => {
    let capturedSendRequest = null;
    const fetchFn = async (url, options = {}) => {
      const urlStr = url.toString();
      if (urlStr.includes("gmail.googleapis.com/gmail/v1/users/me/messages/send")) {
        capturedSendRequest = {
          url: urlStr,
          headers: options.headers,
          body: JSON.parse(options.body),
        };
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: "msg_18c0123456789abc",
            threadId: "th_18c0123456789abc",
            labelIds: ["SENT"],
          }),
        };
      }
      throw new Error(`Unexpected fetch call to: ${urlStr}`);
    };

    const { server, client, encryptionKey } = await createTestApplication({ fetchFn });
    seedConnectedGmail(server, encryptionKey, "nikhil.sender@gmail.com");

    const sendResult = await client.callTool({
      name: "send_test_email",
      arguments: {
        recipientEmail: "recruiter.hiring@company.example",
        recipientName: "Alex Morgan",
        subject: "SDE Opportunities at Company",
        bodyText: "Hello Alex, I am interested in software engineering opportunities.",
        bodyHtml: "<p>Hello Alex, I am interested in software engineering opportunities.</p>",
        confirmSend: true,
      },
    });

    expect(sendResult.isError).not.toBe(true);
    expect(sendResult.structuredContent).toMatchObject({
      success: true,
      sendType: "test",
      recipientEmail: "recruiter.hiring@company.example",
      recipientName: "Alex Morgan",
      subject: "SDE Opportunities at Company",
      hasAttachment: false,
      gmailMessageId: "msg_18c0123456789abc",
      gmailThreadId: "th_18c0123456789abc",
    });

    expect(capturedSendRequest).toBeTruthy();
    expect(capturedSendRequest.headers.Authorization).toBe("Bearer ya29.valid-mock-access-token");
    expect(capturedSendRequest.body).toHaveProperty("raw");

    const decodedMime = Buffer.from(capturedSendRequest.body.raw, "base64url").toString("utf8");
    expect(decodedMime).toContain("To: Alex Morgan <recruiter.hiring@company.example>");
    expect(decodedMime).toContain("Subject: SDE Opportunities at Company");

    const sentRow = server.emailSendingService.database.get(
      "SELECT * FROM sent_emails WHERE gmail_message_id = 'msg_18c0123456789abc'",
    );
    expect(sentRow).toBeTruthy();
    expect(sentRow.recipient_email).toBe("recruiter.hiring@company.example");
    expect(sentRow.send_type).toBe("test");
    expect(sentRow.status).toBe("sent");

    const auditRow = server.emailSendingService.database.get(
      "SELECT * FROM activity_logs WHERE action = 'test_email_sent'",
    );
    expect(auditRow).toBeTruthy();
    expect(JSON.parse(auditRow.details_json).gmailMessageId).toBe("msg_18c0123456789abc");

    await client.close();
    await server.close();
    await server.closeDatabase();
  });

  it("sends test email with active resume attachment and validates attachment integrity", async () => {
    let capturedSendRequest = null;
    const fetchFn = async (url, options = {}) => {
      const urlStr = url.toString();
      if (urlStr.includes("messages/send")) {
        capturedSendRequest = JSON.parse(options.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: "msg_with_resume_999",
            threadId: "th_with_resume_999",
          }),
        };
      }
      throw new Error(`Unexpected fetch call to: ${urlStr}`);
    };

    const { server, client, temporaryDirectory, encryptionKey } = await createTestApplication({ fetchFn });
    seedConnectedGmail(server, encryptionKey);

    const resumePath = path.join(temporaryDirectory, "Nikhil-Engineering-Resume.pdf");
    await fs.writeFile(resumePath, createMinimalPdf("Nikhil Resume Software Development"));
    await client.callTool({ name: "upload_resume", arguments: { sourcePath: resumePath } });

    const sendResult = await client.callTool({
      name: "send_test_email",
      arguments: {
        recipientEmail: "lead.recruiter@tech.example",
        subject: "Application for SDE Intern",
        bodyText: "Please find attached my resume for the SDE intern role.",
        attachActiveResume: true,
        confirmSend: true,
      },
    });

    expect(sendResult.structuredContent).toMatchObject({
      success: true,
      hasAttachment: true,
      attachmentFilename: "Nikhil-Engineering-Resume.pdf",
      gmailMessageId: "msg_with_resume_999",
    });
    expect(sendResult.structuredContent).not.toHaveProperty("attachmentPath");
    expect(sendResult.structuredContent).not.toHaveProperty("storedFilename");

    const decodedMime = Buffer.from(capturedSendRequest.raw, "base64url").toString("utf8");
    expect(decodedMime).toContain("Content-Type: multipart/mixed; boundary=");
    expect(decodedMime).toContain('filename="Nikhil-Engineering-Resume.pdf"');
    expect(decodedMime).toContain("Content-Type: application/pdf;");

    const sentRow = server.emailSendingService.database.get(
      "SELECT * FROM sent_emails WHERE gmail_message_id = 'msg_with_resume_999'",
    );
    expect(sentRow.has_attachment).toBe(1);
    expect(sentRow.attachment_filename).toBe("Nikhil-Engineering-Resume.pdf");

    await client.close();
    await server.close();
    await server.closeDatabase();
  });

  it("populates subject and body from an existing unsent email draft", async () => {
    let capturedSendRequest = null;
    const fetchFn = async (url, options = {}) => {
      capturedSendRequest = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: "msg_from_draft_111", threadId: "th_111" }),
      };
    };

    const { server, client, encryptionKey } = await createTestApplication({ fetchFn });
    seedConnectedGmail(server, encryptionKey);

    const recruiter = await client.callTool({
      name: "create_recruiter",
      arguments: { name: "Tara Singh", email: "tara@acme.example", company: "Acme Corp" },
    });

    const draft = await client.callTool({
      name: "save_email_draft",
      arguments: {
        recruiterId: recruiter.structuredContent.id,
        template: "backend_developer",
        subject: "Inquiry on Backend Developer role at Acme Corp",
        body: "Hello Tara, I am writing to express my strong interest in the backend engineering position at Acme Corp.",
      },
    });

    const sendResult = await client.callTool({
      name: "send_test_email",
      arguments: {
        recipientEmail: "my.personal.email@example.com",
        draftId: draft.structuredContent.id,
        confirmSend: true,
      },
    });

    expect(sendResult.structuredContent).toMatchObject({
      success: true,
      subject: "Inquiry on Backend Developer role at Acme Corp",
      gmailMessageId: "msg_from_draft_111",
    });

    const sentRow = server.emailSendingService.database.get(
      "SELECT * FROM sent_emails WHERE gmail_message_id = 'msg_from_draft_111'",
    );
    expect(sentRow.email_draft_id).toBe(draft.structuredContent.id);
    expect(sentRow.recruiter_id).toBe(recruiter.structuredContent.id);

    await client.close();
    await server.close();
    await server.closeDatabase();
  });

  it("handles Gmail API send errors safely and records failure status", async () => {
    const fetchFn = async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: { message: "Invalid To header" } }),
    });

    const { server, client, encryptionKey } = await createTestApplication({ fetchFn });
    seedConnectedGmail(server, encryptionKey);

    const response = await client.callTool({
      name: "send_test_email",
      arguments: {
        recipientEmail: "invalid-recipient@example.com",
        subject: "Test subject",
        bodyText: "Test body",
        confirmSend: true,
      },
    });
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain("Gmail API send failed (HTTP 400): Invalid To header");

    const failedRow = server.emailSendingService.database.get(
      "SELECT * FROM sent_emails WHERE status = 'failed'",
    );
    expect(failedRow).toBeTruthy();
    expect(failedRow.error_message).toBe("Invalid To header");

    const failedAudit = server.emailSendingService.database.get(
      "SELECT * FROM activity_logs WHERE action = 'test_email_failed'",
    );
    expect(failedAudit).toBeTruthy();

    await client.close();
    await server.close();
    await server.closeDatabase();
  });
});
