import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createMcpServer } from "../src/mcp/server.js";
import { GmailOAuthService, GMAIL_SCOPES } from "../src/services/gmail-oauth.service.js";
import {
  decryptToken,
  deriveKey,
  encryptToken,
  generateEncryptionKey,
} from "../src/utils/crypto.js";

const temporaryDirectories = [];

async function createTestServer(options = {}) {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-email-gmail-test-"));
  temporaryDirectories.push(temporaryDirectory);

  const server = await createMcpServer({
    databasePath: path.join(temporaryDirectory, "test.sqlite"),
    uploadsDirectory: path.join(temporaryDirectory, "uploads"),
    ...options,
  });

  const client = new Client({ name: "gmail-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return { server, client, temporaryDirectory };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("AES-256-GCM Token Encryption", () => {
  const secret = "test-encryption-key-for-phase-5-oauth";

  it("derives consistent 32-byte key from secret", () => {
    const key1 = deriveKey(secret);
    const key2 = deriveKey(secret);
    expect(key1).toHaveLength(32);
    expect(key1).toEqual(key2);
  });

  it("throws when secret is missing or empty", () => {
    expect(() => deriveKey("")).toThrow(/TOKEN_ENCRYPTION_KEY/);
    expect(() => deriveKey(null)).toThrow(/TOKEN_ENCRYPTION_KEY/);
    expect(() => deriveKey("   ")).toThrow(/TOKEN_ENCRYPTION_KEY/);
  });

  it("encrypts and decrypts tokens successfully", () => {
    const originalToken = "ya29.a0AfH6SMD_mock_access_token_123456789";
    const encrypted = encryptToken(originalToken, secret);

    expect(encrypted).not.toContain(originalToken);
    const parsed = JSON.parse(encrypted);
    expect(parsed).toHaveProperty("iv");
    expect(parsed).toHaveProperty("tag");
    expect(parsed).toHaveProperty("data");

    const decrypted = decryptToken(encrypted, secret);
    expect(decrypted).toBe(originalToken);
  });

  it("generates different ciphertexts for the same plaintext due to random IV", () => {
    const token = "mock-refresh-token-secret";
    const enc1 = encryptToken(token, secret);
    const enc2 = encryptToken(token, secret);
    expect(enc1).not.toBe(enc2);
    expect(decryptToken(enc1, secret)).toBe(token);
    expect(decryptToken(enc2, secret)).toBe(token);
  });

  it("detects tampering and throws on corrupted ciphertext or tag", () => {
    const token = "sensitive-oauth-token";
    const encrypted = encryptToken(token, secret);
    const envelope = JSON.parse(encrypted);

    envelope.data = (parseInt(envelope.data[0], 16) ^ 1).toString(16) + envelope.data.slice(1);
    expect(() => decryptToken(JSON.stringify(envelope), secret)).toThrow(/authentication failed/);

    const envelope2 = JSON.parse(encrypted);
    envelope2.tag = (parseInt(envelope2.tag[0], 16) ^ 1).toString(16) + envelope2.tag.slice(1);
    expect(() => decryptToken(JSON.stringify(envelope2), secret)).toThrow(/authentication failed/);
  });

  it("generateEncryptionKey produces a 64-char hex string (32 bytes)", () => {
    const key = generateEncryptionKey();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("Gmail OAuth Service & MCP Tools", () => {
  const mockConfig = {
    clientId: "mock-client-id.apps.googleusercontent.com",
    clientSecret: "mock-client-secret-12345",
    redirectUri: "http://127.0.0.1:54321/callback",
    encryptionKey: "mock-encryption-passphrase-for-testing",
  };

  function createMockFetch({
    tokenResponse = {
      access_token: "ya29.mock-access-token",
      refresh_token: "1//mock-refresh-token",
      expires_in: 3600,
      scope: GMAIL_SCOPES.join(" "),
      token_type: "Bearer",
    },
    profileResponse = {
      emailAddress: "recruiter.outreach.test@gmail.com",
      messagesTotal: 50,
      threadsTotal: 25,
    },
    tokenStatus = 200,
    profileStatus = 200,
  } = {}) {
    return async (url, options = {}) => {
      const urlStr = url.toString();
      if (urlStr.includes("oauth2.googleapis.com/token")) {
        return {
          ok: tokenStatus >= 200 && tokenStatus < 300,
          status: tokenStatus,
          json: async () => tokenResponse,
          text: async () => JSON.stringify(tokenResponse),
        };
      }
      if (urlStr.includes("gmail.googleapis.com/gmail/v1/users/me/profile")) {
        return {
          ok: profileStatus >= 200 && profileStatus < 300,
          status: profileStatus,
          json: async () => profileResponse,
          text: async () => JSON.stringify(profileResponse),
        };
      }
      throw new Error(`Unexpected fetch call to: ${urlStr}`);
    };
  }

  it("reports missing configuration when environment credentials are not set", async () => {
    const { server, client } = await createTestServer({
      clientId: "",
      clientSecret: "",
      encryptionKey: "",
    });

    const statusResult = await client.callTool({ name: "get_gmail_status", arguments: {} });
    expect(statusResult.structuredContent).toMatchObject({
      configured: false,
      connected: false,
      status: "credentials_missing",
      missingConfiguration: expect.arrayContaining([
        "GOOGLE_CLIENT_ID",
        "GOOGLE_CLIENT_SECRET",
        "TOKEN_ENCRYPTION_KEY",
      ]),
    });

    const connectResult = await client.callTool({ name: "connect_gmail", arguments: {} });
    expect(connectResult.structuredContent).toMatchObject({
      connected: false,
      configured: false,
    });

    await client.close();
    await server.close();
    await server.closeDatabase();
  });

  it("generates authorization URL with minimum scopes and offline access", async () => {
    const { server, client } = await createTestServer({
      ...mockConfig,
      fetchFn: createMockFetch(),
    });

    const result = await client.callTool({
      name: "connect_gmail",
      arguments: { startLocalListener: false },
    });

    expect(result.structuredContent).toMatchObject({
      status: "awaiting_authorization",
      redirectUri: "http://127.0.0.1:54321/callback",
    });

    const authUrl = new URL(result.structuredContent.authorizationUrl);
    expect(authUrl.origin + authUrl.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(authUrl.searchParams.get("client_id")).toBe(mockConfig.clientId);
    expect(authUrl.searchParams.get("redirect_uri")).toBe(mockConfig.redirectUri);
    expect(authUrl.searchParams.get("response_type")).toBe("code");
    expect(authUrl.searchParams.get("access_type")).toBe("offline");
    expect(authUrl.searchParams.get("prompt")).toBe("consent");

    const scopes = authUrl.searchParams.get("scope").split(" ");
    expect(scopes).toEqual(expect.arrayContaining([
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.readonly",
    ]));
    expect(scopes).toHaveLength(2);

    await client.close();
    await server.close();
    await server.closeDatabase();
  });

  it("exchanges authorization code, encrypts tokens at rest, and logs activity", async () => {
    const fetchFn = createMockFetch();
    const { server, client } = await createTestServer({
      ...mockConfig,
      fetchFn,
    });

    const exchangeResult = await client.callTool({
      name: "connect_gmail",
      arguments: { authorizationCode: "4/0AeanS0MockAuthCode" },
    });

    expect(exchangeResult.structuredContent).toMatchObject({
      connected: true,
      email: "recruiter.outreach.test@gmail.com",
      hasRefreshToken: true,
      scopes: expect.arrayContaining([
        "https://www.googleapis.com/auth/gmail.send",
        "https://www.googleapis.com/auth/gmail.readonly",
      ]),
    });
    expect(exchangeResult.structuredContent).not.toHaveProperty("accessToken");
    expect(exchangeResult.structuredContent).not.toHaveProperty("refreshToken");

    const dbRow = server.gmailOAuthService.database.get(
      "SELECT * FROM gmail_tokens WHERE id = 1",
    );
    expect(dbRow).toBeTruthy();
    expect(dbRow.email).toBe("recruiter.outreach.test@gmail.com");
    expect(dbRow.encrypted_access_token).not.toContain("ya29.mock-access-token");
    expect(dbRow.encrypted_refresh_token).not.toContain("1//mock-refresh-token");

    const decryptedAccess = decryptToken(dbRow.encrypted_access_token, mockConfig.encryptionKey);
    const decryptedRefresh = decryptToken(dbRow.encrypted_refresh_token, mockConfig.encryptionKey);
    expect(decryptedAccess).toBe("ya29.mock-access-token");
    expect(decryptedRefresh).toBe("1//mock-refresh-token");

    const auditLog = server.gmailOAuthService.database.get(
      "SELECT * FROM activity_logs WHERE action = 'gmail_connected'",
    );
    expect(auditLog).toBeTruthy();
    expect(JSON.parse(auditLog.details_json).email).toBe("recruiter.outreach.test@gmail.com");

    const statusResult = await client.callTool({ name: "get_gmail_status", arguments: {} });
    expect(statusResult.structuredContent).toMatchObject({
      configured: true,
      connected: true,
      email: "recruiter.outreach.test@gmail.com",
      status: "connected",
      hasRefreshToken: true,
    });
    expect(statusResult.structuredContent).not.toHaveProperty("accessToken");
    expect(statusResult.structuredContent).not.toHaveProperty("refreshToken");

    await client.close();
    await server.close();
    await server.closeDatabase();
  });

  it("automatically refreshes expired access token when status is checked", async () => {
    let refreshCalls = 0;
    const fetchFn = async (url, options = {}) => {
      const urlStr = url.toString();
      if (urlStr.includes("oauth2.googleapis.com/token")) {
        const body = options.body ? options.body.toString() : "";
        if (body.includes("grant_type=authorization_code")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              access_token: "ya29.first-access-token",
              refresh_token: "1//original-refresh-token",
              expires_in: 3600,
              scope: GMAIL_SCOPES.join(" "),
              token_type: "Bearer",
            }),
          };
        }
        if (body.includes("grant_type=refresh_token")) {
          refreshCalls++;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              access_token: "ya29.refreshed-access-token-999",
              expires_in: 3600,
              scope: GMAIL_SCOPES.join(" "),
              token_type: "Bearer",
            }),
          };
        }
      }
      if (urlStr.includes("gmail.googleapis.com/gmail/v1/users/me/profile")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ emailAddress: "auto.refresh@gmail.com" }),
        };
      }
      throw new Error(`Unexpected URL: ${urlStr}`);
    };

    const { server, client } = await createTestServer({
      ...mockConfig,
      fetchFn,
    });

    await client.callTool({
      name: "connect_gmail",
      arguments: { authorizationCode: "initial-auth-code" },
    });

    server.gmailOAuthService.database.run(
      "UPDATE gmail_tokens SET expiry_date = ? WHERE id = 1",
      [Date.now() - 1000],
    );

    const status = await client.callTool({ name: "get_gmail_status", arguments: {} });
    expect(status.structuredContent).toMatchObject({
      connected: true,
      status: "connected",
      email: "auto.refresh@gmail.com",
    });
    expect(refreshCalls).toBe(1);

    const validToken = await server.gmailOAuthService.getValidAccessToken();
    expect(validToken).toBe("ya29.refreshed-access-token-999");

    const refreshAudit = server.gmailOAuthService.database.get(
      "SELECT * FROM activity_logs WHERE action = 'gmail_token_refreshed'",
    );
    expect(refreshAudit).toBeTruthy();

    await client.close();
    await server.close();
    await server.closeDatabase();
  });

  it("handles revoked or invalid refresh token gracefully without leaking secrets", async () => {
    const fetchFn = async (url, options = {}) => {
      const urlStr = url.toString();
      if (urlStr.includes("oauth2.googleapis.com/token")) {
        const body = options.body ? options.body.toString() : "";
        if (body.includes("grant_type=authorization_code")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              access_token: "ya29.temp",
              refresh_token: "1//revoked-refresh-token",
              expires_in: 3600,
              scope: GMAIL_SCOPES.join(" "),
            }),
          };
        }
        return {
          ok: false,
          status: 400,
          text: async () => JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ emailAddress: "revoked@gmail.com" }),
      };
    };

    const { server, client } = await createTestServer({
      ...mockConfig,
      fetchFn,
    });

    await client.callTool({
      name: "connect_gmail",
      arguments: { authorizationCode: "initial-code" },
    });

    server.gmailOAuthService.database.run(
      "UPDATE gmail_tokens SET expiry_date = ? WHERE id = 1",
      [Date.now() - 5000],
    );

    const status = await client.callTool({ name: "get_gmail_status", arguments: {} });
    expect(status.structuredContent).toMatchObject({
      connected: false,
      status: "token_expired_refresh_failed",
    });

    await client.close();
    await server.close();
    await server.closeDatabase();
  });

  it("requires confirmDisconnect: true to disconnect Gmail and delete tokens", async () => {
    const fetchFn = createMockFetch();
    const { server, client } = await createTestServer({
      ...mockConfig,
      fetchFn,
    });

    await client.callTool({
      name: "connect_gmail",
      arguments: { authorizationCode: "auth-code" },
    });

    const unconfirmed = await client.callTool({
      name: "connect_gmail",
      arguments: { disconnect: true },
    });
    expect(unconfirmed.structuredContent.disconnected).toBe(false);
    expect(unconfirmed.structuredContent.error).toContain("confirmDisconnect: true");

    const rowBefore = server.gmailOAuthService.database.get("SELECT id FROM gmail_tokens WHERE id = 1");
    expect(rowBefore).toBeTruthy();

    const confirmed = await client.callTool({
      name: "connect_gmail",
      arguments: { disconnect: true, confirmDisconnect: true },
    });
    expect(confirmed.structuredContent.disconnected).toBe(true);

    const rowAfter = server.gmailOAuthService.database.get("SELECT id FROM gmail_tokens WHERE id = 1");
    expect(rowAfter).toBeNull();

    const disconnectAudit = server.gmailOAuthService.database.get(
      "SELECT * FROM activity_logs WHERE action = 'gmail_disconnected'",
    );
    expect(disconnectAudit).toBeTruthy();

    const finalStatus = await client.callTool({ name: "get_gmail_status", arguments: {} });
    expect(finalStatus.structuredContent).toMatchObject({
      connected: false,
      status: "not_connected",
    });

    await client.close();
    await server.close();
    await server.closeDatabase();
  });

  it("processes authorization callback request and saves tokens", async () => {
    const port = 54322;
    const redirectUri = `http://127.0.0.1:${port}/callback`;
    const fetchFn = createMockFetch();

    const { server, client } = await createTestServer({
      ...mockConfig,
      redirectUri,
      fetchFn,
    });

    const mockReq = { url: `/callback?code=mock-browser-code-123` };
    let responseStatus = 0;
    let responseBody = "";
    const mockRes = {
      writeHead: (status) => { responseStatus = status; },
      end: (data) => { responseBody = data; },
    };

    await server.gmailOAuthService.handleCallbackRequest(mockReq, mockRes, { redirectUri });

    expect(responseStatus).toBe(200);
    expect(responseBody).toContain("Authentication Successful");

    const status = await client.callTool({ name: "get_gmail_status", arguments: {} });
    expect(status.structuredContent).toMatchObject({
      connected: true,
      email: "recruiter.outreach.test@gmail.com",
    });

    await client.close();
    await server.close();
    await server.closeDatabase();
  });

  it("handles OAuth callback error parameter safely", async () => {
    const { server, client } = await createTestServer({
      ...mockConfig,
      fetchFn: createMockFetch(),
    });

    const mockReq = { url: `/callback?error=access_denied` };
    let responseStatus = 0;
    let responseBody = "";
    const mockRes = {
      writeHead: (status) => { responseStatus = status; },
      end: (data) => { responseBody = data; },
    };

    await server.gmailOAuthService.handleCallbackRequest(mockReq, mockRes);
    expect(responseStatus).toBe(400);
    expect(responseBody).toContain("Authorization Failed");

    await client.close();
    await server.close();
    await server.closeDatabase();
  });
});
