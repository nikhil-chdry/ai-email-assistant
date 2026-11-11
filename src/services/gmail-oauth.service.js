import http from "node:http";
import { URL, URLSearchParams } from "node:url";
import { encryptToken, decryptToken } from "../utils/crypto.js";
import { logError, logInfo } from "../utils/logger.js";

export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
];

const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GMAIL_PROFILE_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/profile";

export class GmailOAuthService {
  /**
   * @param {object} options
   * @param {import('../database/connection.js').LocalDatabase} options.database
   * @param {string} [options.clientId]
   * @param {string} [options.clientSecret]
   * @param {string} [options.redirectUri]
   * @param {string} [options.encryptionKey]
   * @param {typeof fetch} [options.fetchFn]
   */
  constructor({
    database,
    clientId = process.env.GOOGLE_CLIENT_ID,
    clientSecret = process.env.GOOGLE_CLIENT_SECRET,
    redirectUri = process.env.GOOGLE_REDIRECT_URI || "http://127.0.0.1:54321/callback",
    encryptionKey = process.env.TOKEN_ENCRYPTION_KEY || process.env.GMAIL_TOKEN_ENCRYPTION_KEY,
    fetchFn = globalThis.fetch,
  } = {}) {
    this.database = database;
    this.clientId = clientId?.trim();
    this.clientSecret = clientSecret?.trim();
    this.redirectUri = redirectUri?.trim();
    this.encryptionKey = encryptionKey?.trim();
    this.fetchFn = fetchFn;
    this.activeServer = null;
    this.serverTimeout = null;
  }

  /**
   * Checks whether the necessary environment configuration is present.
   *
   * @returns {{ configured: boolean, missing: string[] }}
   */
  checkConfiguration() {
    const missing = [];
    if (!this.clientId) missing.push("GOOGLE_CLIENT_ID");
    if (!this.clientSecret) missing.push("GOOGLE_CLIENT_SECRET");
    if (!this.encryptionKey) missing.push("TOKEN_ENCRYPTION_KEY");

    return {
      configured: missing.length === 0,
      missing,
    };
  }

  /**
   * Generates Google OAuth 2.0 authorization URL with required minimum scopes.
   *
   * @param {object} [options]
   * @param {string} [options.redirectUri]
   * @param {string} [options.state]
   * @returns {string}
   */
  getAuthorizationUrl({ redirectUri = this.redirectUri, state } = {}) {
    const { configured, missing } = this.checkConfiguration();
    if (!configured) {
      throw new Error(`Cannot generate authorization URL: missing configuration (${missing.join(", ")}).`);
    }

    const url = new URL(GOOGLE_AUTH_ENDPOINT);
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", GMAIL_SCOPES.join(" "));
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("include_granted_scopes", "true");
    if (state) {
      url.searchParams.set("state", state);
    }

    return url.toString();
  }

  /**
   * Processes an incoming HTTP request for the OAuth callback.
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {object} [options]
   * @param {string} [options.redirectUri]
   */
  async handleCallbackRequest(req, res, { redirectUri = this.redirectUri } = {}) {
    let port = 54321;
    try {
      const parsedUrl = new URL(redirectUri);
      if (parsedUrl.port) {
        port = parseInt(parsedUrl.port, 10);
      }
    } catch {
      // Fallback
    }

    try {
      const reqUrl = new URL(req.url, `http://127.0.0.1:${port}`);
      const code = reqUrl.searchParams.get("code");
      const error = reqUrl.searchParams.get("error");

      if (error) {
        logError("OAuth callback reported an error", { error });
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`
          <!DOCTYPE html>
          <html>
            <body style="font-family:sans-serif;text-align:center;padding:40px;">
              <h2 style="color:#dc2626;">Authorization Failed</h2>
              <p>Google OAuth returned an error: <strong>${escapeHtml(error)}</strong></p>
              <p>You can close this tab and try again.</p>
            </body>
          </html>
        `);
        this.stopLocalCallbackListener();
        return;
      }

      if (code) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`
          <!DOCTYPE html>
          <html>
            <body style="font-family:sans-serif;text-align:center;padding:40px;background:#f9fafb;">
              <h2 style="color:#16a34a;">Authentication Successful!</h2>
              <p>Gmail has been authorized for AI Email Assistant.</p>
              <p>Your tokens are being encrypted and securely stored locally.</p>
              <p>You can safely close this window and return to Claude / Antigravity.</p>
            </body>
          </html>
        `);

        try {
          await this.exchangeCodeForTokens(code, { redirectUri });
          logInfo("OAuth callback processed successfully via local listener.");
        } catch (err) {
          logError("Failed to exchange code from callback", err);
        } finally {
          this.stopLocalCallbackListener();
        }
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    } catch (err) {
      logError("Error handling callback request", err);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
      this.stopLocalCallbackListener();
    }
  }

  /**
   * Starts a transient local HTTP server to capture the OAuth redirect callback.
   * Automatically closes after receiving callback or on timeout.
   *
   * @param {object} [options]
   * @param {string} [options.redirectUri]
   * @param {number} [options.timeoutMs]
   * @returns {Promise<{ started: boolean, port: number, redirectUri: string, message?: string }>}
   */
  async startLocalCallbackListener({
    redirectUri = this.redirectUri,
    timeoutMs = 5 * 60 * 1000,
  } = {}) {
    this.stopLocalCallbackListener();

    let port = 54321;
    try {
      const parsedUrl = new URL(redirectUri);
      if (parsedUrl.port) {
        port = parseInt(parsedUrl.port, 10);
      }
    } catch {
      // Fallback to default port if URI is malformed
    }

    return new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        this.handleCallbackRequest(req, res, { redirectUri });
      });

      server.on("error", (err) => {
        logInfo("Could not start local OAuth callback listener", { code: err.code, message: err.message });
        this.activeServer = null;
        resolve({
          started: false,
          port,
          redirectUri,
          message: `Local listener could not bind to port ${port}: ${err.message}. Use manual authorizationCode entry instead.`,
        });
      });

      server.listen(port, "127.0.0.1", () => {
        this.activeServer = server;
        this.serverTimeout = setTimeout(() => {
          logInfo("OAuth callback listener timed out.");
          this.stopLocalCallbackListener();
        }, timeoutMs);

        resolve({
          started: true,
          port,
          redirectUri,
        });
      });
    });
  }

  /**
   * Stops the active local callback listener if running.
   */
  stopLocalCallbackListener() {
    if (this.serverTimeout) {
      clearTimeout(this.serverTimeout);
      this.serverTimeout = null;
    }
    if (this.activeServer) {
      try {
        this.activeServer.close();
      } catch {
        // ignore errors on close
      }
      this.activeServer = null;
    }
  }

  /**
   * Exchanges an authorization code for tokens, retrieves user profile,
   * encrypts tokens at rest, and updates the local database.
   *
   * @param {string} code
   * @param {object} [options]
   * @param {string} [options.redirectUri]
   * @returns {Promise<{ connected: boolean, email: string, scopes: string[], expiryDate: string, hasRefreshToken: boolean }>}
   */
  async exchangeCodeForTokens(code, { redirectUri = this.redirectUri } = {}) {
    if (!code || typeof code !== "string" || code.trim().length === 0) {
      throw new Error("Authorization code must be a non-empty string.");
    }

    const { configured, missing } = this.checkConfiguration();
    if (!configured) {
      throw new Error(`Cannot exchange authorization code: missing configuration (${missing.join(", ")}).`);
    }

    const body = new URLSearchParams({
      code: code.trim(),
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    });

    let tokenResponse;
    try {
      const response = await this.fetchFn(GOOGLE_TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logError("Google token exchange endpoint returned error", { status: response.status });
        throw new Error(`Token exchange failed (HTTP ${response.status}): ${extractOAuthError(errorText)}`);
      }

      tokenResponse = await response.json();
    } catch (err) {
      if (err.message.startsWith("Token exchange failed")) {
        throw err;
      }
      logError("Failed to reach Google token exchange endpoint", err);
      throw new Error(`Failed to reach Google OAuth endpoint: ${err.message}`);
    }

    const {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: expiresIn = 3600,
      scope = GMAIL_SCOPES.join(" "),
      token_type: tokenType = "Bearer",
    } = tokenResponse;

    if (!accessToken) {
      throw new Error("Token exchange response did not contain an access_token.");
    }

    let email = await this.#fetchUserEmail(accessToken);

    const now = new Date();
    const expiryDate = Date.now() + expiresIn * 1000;
    const encryptedAccessToken = encryptToken(accessToken, this.encryptionKey);
    const encryptedRefreshToken = refreshToken
      ? encryptToken(refreshToken, this.encryptionKey)
      : null;

    await this.database.transaction((db) => {
      const existing = db.get("SELECT encrypted_refresh_token FROM gmail_tokens WHERE id = 1");
      const finalRefreshToken = encryptedRefreshToken ?? existing?.encrypted_refresh_token ?? null;

      db.run(
        `INSERT INTO gmail_tokens (
          id, email, encrypted_access_token, encrypted_refresh_token,
          token_type, scope, expiry_date, created_at, updated_at
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          email = excluded.email,
          encrypted_access_token = excluded.encrypted_access_token,
          encrypted_refresh_token = COALESCE(excluded.encrypted_refresh_token, gmail_tokens.encrypted_refresh_token),
          token_type = excluded.token_type,
          scope = excluded.scope,
          expiry_date = excluded.expiry_date,
          updated_at = excluded.updated_at`,
        [
          email,
          encryptedAccessToken,
          finalRefreshToken,
          tokenType,
          scope,
          expiryDate,
          now.toISOString(),
          now.toISOString(),
        ],
      );

      db.run(
        `INSERT INTO activity_logs (action, details_json, created_at) VALUES (?, ?, ?)`,
        [
          "gmail_connected",
          JSON.stringify({ email, scopes: scope.split(" ").filter(Boolean) }),
          now.toISOString(),
        ],
      );
    });

    this.stopLocalCallbackListener();

    return {
      connected: true,
      email,
      scopes: scope.split(" ").filter(Boolean),
      expiryDate: new Date(expiryDate).toISOString(),
      hasRefreshToken: Boolean(encryptedRefreshToken),
    };
  }

  /**
   * Refreshes the stored access token using the stored refresh token.
   *
   * @returns {Promise<string>} The fresh decrypted access token (internal use only; never expose via MCP).
   */
  async refreshAccessToken() {
    const { configured, missing } = this.checkConfiguration();
    if (!configured) {
      throw new Error(`Cannot refresh token: missing configuration (${missing.join(", ")}).`);
    }

    const row = this.database.get("SELECT * FROM gmail_tokens WHERE id = 1");
    if (!row || !row.encrypted_refresh_token) {
      throw new Error("No refresh token available. Re-authorization with connect_gmail is required.");
    }

    let refreshToken;
    try {
      refreshToken = decryptToken(row.encrypted_refresh_token, this.encryptionKey);
    } catch (err) {
      logError("Failed to decrypt stored refresh token", err);
      throw new Error("Failed to decrypt stored refresh token. Encryption key may have changed.");
    }

    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    });

    let tokenResponse;
    try {
      const response = await this.fetchFn(GOOGLE_TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logError("Google token refresh returned error", { status: response.status });
        throw new Error(`Token refresh failed (HTTP ${response.status}): ${extractOAuthError(errorText)}`);
      }

      tokenResponse = await response.json();
    } catch (err) {
      if (err.message.startsWith("Token refresh failed")) {
        throw err;
      }
      logError("Failed to reach Google token endpoint during refresh", err);
      throw new Error(`Failed to reach Google token endpoint during refresh: ${err.message}`);
    }

    const {
      access_token: newAccessToken,
      refresh_token: rotatedRefreshToken,
      expires_in: expiresIn = 3600,
      scope = row.scope,
    } = tokenResponse;

    if (!newAccessToken) {
      throw new Error("Refresh response did not contain an access_token.");
    }

    const now = new Date();
    const expiryDate = Date.now() + expiresIn * 1000;
    const encryptedAccessToken = encryptToken(newAccessToken, this.encryptionKey);
    const encryptedRotatedRefreshToken = rotatedRefreshToken
      ? encryptToken(rotatedRefreshToken, this.encryptionKey)
      : row.encrypted_refresh_token;

    await this.database.transaction((db) => {
      db.run(
        `UPDATE gmail_tokens SET
          encrypted_access_token = ?,
          encrypted_refresh_token = ?,
          scope = ?,
          expiry_date = ?,
          updated_at = ?
        WHERE id = 1`,
        [encryptedAccessToken, encryptedRotatedRefreshToken, scope, expiryDate, now.toISOString()],
      );

      db.run(
        `INSERT INTO activity_logs (action, details_json, created_at) VALUES (?, ?, ?)`,
        ["gmail_token_refreshed", JSON.stringify({ email: row.email }), now.toISOString()],
      );
    });

    return newAccessToken;
  }

  /**
   * Retrieves an active valid decrypted access token for internal API operations.
   * Refreshes automatically if expired or within 60s of expiration.
   *
   * @returns {Promise<string>}
   */
  async getValidAccessToken() {
    const row = this.database.get("SELECT * FROM gmail_tokens WHERE id = 1");
    if (!row) {
      throw new Error("Gmail is not connected. Use connect_gmail first.");
    }

    const isExpiringSoon = Date.now() >= row.expiry_date - 60_000;
    if (isExpiringSoon) {
      return this.refreshAccessToken();
    }

    try {
      return decryptToken(row.encrypted_access_token, this.encryptionKey);
    } catch {
      return this.refreshAccessToken();
    }
  }

  /**
   * Returns the current Gmail connection and configuration status.
   * Never exposes raw tokens or secrets.
   *
   * @returns {Promise<object>}
   */
  async getStatus() {
    const configCheck = this.checkConfiguration();
    if (!configCheck.configured) {
      return {
        configured: false,
        connected: false,
        status: "credentials_missing",
        missingConfiguration: configCheck.missing,
        notes: [
          "Google OAuth credentials (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET) or TOKEN_ENCRYPTION_KEY missing.",
          "Configure these variables in your .env file according to .env.example and README instructions.",
        ],
      };
    }

    const row = this.database.get("SELECT * FROM gmail_tokens WHERE id = 1");
    if (!row) {
      return {
        configured: true,
        connected: false,
        status: "not_connected",
        notes: [
          "Gmail is not connected.",
          "Use connect_gmail to generate an authorization URL and connect your account.",
        ],
      };
    }

    const isExpired = Date.now() >= row.expiry_date - 60_000;
    if (isExpired) {
      if (row.encrypted_refresh_token) {
        try {
          await this.refreshAccessToken();
          const refreshedRow = this.database.get("SELECT * FROM gmail_tokens WHERE id = 1");
          return {
            configured: true,
            connected: true,
            email: refreshedRow.email,
            scopes: refreshedRow.scope.split(" ").filter(Boolean),
            expiryDate: new Date(refreshedRow.expiry_date).toISOString(),
            hasRefreshToken: true,
            status: "connected",
            notes: [
              "Access token was refreshed automatically using the stored refresh token.",
              "Phase 5 implements OAuth connection only; email sending is enabled in Phase 6.",
            ],
          };
        } catch (err) {
          return {
            configured: true,
            connected: false,
            email: row.email,
            status: "token_expired_refresh_failed",
            error: "Stored access token is expired and refresh failed. Please reconnect using connect_gmail.",
            notes: ["Re-authorization is required to resume Gmail integration."],
          };
        }
      }

      return {
        configured: true,
        connected: false,
        email: row.email,
        status: "token_expired_no_refresh_token",
        error: "Stored access token is expired and no refresh token is stored. Please reconnect using connect_gmail.",
      };
    }

    return {
      configured: true,
      connected: true,
      email: row.email,
      scopes: row.scope.split(" ").filter(Boolean),
      expiryDate: new Date(row.expiry_date).toISOString(),
      hasRefreshToken: Boolean(row.encrypted_refresh_token),
      status: "connected",
      notes: [
        "Gmail OAuth connection is active.",
        "Phase 5 implements OAuth connection and status only; email sending is enabled in Phase 6.",
      ],
    };
  }

  /**
   * Disconnects the Gmail account and deletes tokens. Requires confirmation.
   *
   * @param {object} options
   * @param {boolean} options.confirmDisconnect
   * @returns {Promise<{ disconnected: boolean, message: string }>}
   */
  async disconnect({ confirmDisconnect = false } = {}) {
    if (confirmDisconnect !== true) {
      throw new Error("Disconnecting Gmail requires confirmDisconnect: true.");
    }

    this.stopLocalCallbackListener();

    await this.database.transaction((db) => {
      const existing = db.get("SELECT email FROM gmail_tokens WHERE id = 1");
      db.run("DELETE FROM gmail_tokens WHERE id = 1");
      db.run(
        `INSERT INTO activity_logs (action, details_json, created_at) VALUES (?, ?, ?)`,
        [
          "gmail_disconnected",
          JSON.stringify({ email: existing?.email ?? null }),
          new Date().toISOString(),
        ],
      );
    });

    return {
      disconnected: true,
      message: "Gmail account successfully disconnected and local tokens deleted.",
    };
  }

  /**
   * Cleanup on server close.
   */
  async close() {
    this.stopLocalCallbackListener();
  }

  /**
   * Internal helper to fetch the user's Gmail address using the access token.
   *
   * @param {string} accessToken
   * @returns {Promise<string>}
   */
  async #fetchUserEmail(accessToken) {
    try {
      const response = await this.fetchFn(GMAIL_PROFILE_ENDPOINT, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (response.ok) {
        const data = await response.json();
        if (data.emailAddress) {
          return data.emailAddress;
        }
      }
    } catch {
      // Ignore network errors on email lookup fallback
    }
    return "unknown@gmail.com";
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function extractOAuthError(rawText) {
  try {
    const parsed = JSON.parse(rawText);
    return parsed.error_description || parsed.error || rawText;
  } catch {
    return rawText.slice(0, 200);
  }
}
