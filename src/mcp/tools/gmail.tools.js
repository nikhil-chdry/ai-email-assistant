import { z } from "zod";

function result(textContent, structuredContent) {
  return {
    content: [{ type: "text", text: textContent }],
    structuredContent,
  };
}

export function registerGmailTools(server, gmailOAuthService) {
  server.registerTool(
    "connect_gmail",
    {
      title: "Connect Gmail account",
      description:
        "Initiates or completes local Google OAuth 2.0 connection with minimum scopes (gmail.send, gmail.readonly). Generates authorization URL, starts a transient local callback listener, or exchanges an authorization code. Encrypts tokens at rest using TOKEN_ENCRYPTION_KEY.",
      inputSchema: z
        .object({
          authorizationCode: z
            .string()
            .trim()
            .min(1)
            .optional()
            .describe(
              "Authorization code obtained from Google OAuth consent. Provide this to complete authentication, or omit it to start authorization.",
            ),
          redirectUri: z
            .string()
            .trim()
            .url()
            .optional()
            .describe(
              "Optional custom redirect URI (must match Google Cloud Console; defaults to configured redirect URI or http://127.0.0.1:54321/callback).",
            ),
          startLocalListener: z
            .boolean()
            .default(true)
            .describe(
              "Whether to start a temporary local HTTP server to capture the redirect callback automatically. Defaults to true.",
            ),
          disconnect: z
            .boolean()
            .optional()
            .describe("Set to true to disconnect the currently connected Gmail account."),
          confirmDisconnect: z
            .boolean()
            .optional()
            .describe("Explicit confirmation required when disconnect is true."),
        })
        .strict(),
    },
    async (input) => {
      if (input.disconnect) {
        if (input.confirmDisconnect !== true) {
          return result(
            "Confirmation required to disconnect Gmail.",
            {
              disconnected: false,
              error: "Disconnecting Gmail requires confirmDisconnect: true.",
            },
          );
        }
        const disconnected = await gmailOAuthService.disconnect({ confirmDisconnect: true });
        return result(disconnected.message, disconnected);
      }

      if (input.authorizationCode) {
        const exchangeResult = await gmailOAuthService.exchangeCodeForTokens(
          input.authorizationCode,
          { redirectUri: input.redirectUri },
        );
        return result(
          `Gmail account (${exchangeResult.email}) connected successfully. Tokens are encrypted at rest.`,
          exchangeResult,
        );
      }

      const config = gmailOAuthService.checkConfiguration();
      if (!config.configured) {
        return result(
          "Gmail OAuth configuration is missing in environment (.env).",
          {
            connected: false,
            configured: false,
            missingConfiguration: config.missing,
            instructions: [
              "Create a Google Cloud Project with the Gmail API enabled.",
              "Create an OAuth 2.0 Client ID (Desktop or Web application).",
              "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in your .env file.",
              "Set TOKEN_ENCRYPTION_KEY in your .env file to a secure random passphrase.",
              "Refer to .env.example and README.md for complete instructions.",
            ],
          },
        );
      }

      const currentStatus = await gmailOAuthService.getStatus();
      if (currentStatus.connected) {
        return result(
          `Gmail account (${currentStatus.email}) is already connected.`,
          {
            ...currentStatus,
            note: "Gmail is already connected. To re-authenticate, pass an authorizationCode, or pass disconnect: true with confirmDisconnect: true first.",
          },
        );
      }

      const targetRedirectUri = input.redirectUri ?? gmailOAuthService.redirectUri;
      const authorizationUrl = gmailOAuthService.getAuthorizationUrl({
        redirectUri: targetRedirectUri,
      });

      let listenerInfo = { started: false };
      if (input.startLocalListener) {
        listenerInfo = await gmailOAuthService.startLocalCallbackListener({
          redirectUri: targetRedirectUri,
        });
      }

      return result(
        "Gmail authorization flow initiated. Open the authorization URL in your browser.",
        {
          status: "awaiting_authorization",
          authorizationUrl,
          redirectUri: targetRedirectUri,
          localListenerActive: listenerInfo.started,
          listenerPort: listenerInfo.port,
          instructions: [
            "1. Open the authorizationUrl in your browser to approve Gmail permissions (gmail.send, gmail.readonly).",
            listenerInfo.started
              ? `2. After approval, Google will redirect to http://127.0.0.1:${listenerInfo.port}/callback, which completes authentication automatically.`
              : "2. After approval, copy the 'code' parameter from the redirected browser URL.",
            "3. If manual entry is needed, call connect_gmail with { authorizationCode: '<code>' }.",
          ],
        },
      );
    },
  );

  server.registerTool(
    "get_gmail_status",
    {
      title: "Get Gmail connection status",
      description:
        "Returns the local Gmail OAuth connection status, authorized scopes, token expiration, and refresh availability. Does not expose OAuth tokens or credentials.",
      inputSchema: z.object({}).strict(),
    },
    async () => {
      const status = await gmailOAuthService.getStatus();
      const text = status.connected
        ? `Gmail is connected (${status.email}). Scopes: ${status.scopes.join(", ")}.`
        : status.configured
          ? "Gmail is configured but not connected. Run connect_gmail to authorize."
          : `Gmail is not configured. Missing: ${(status.missingConfiguration || []).join(", ")}.`;
      return result(text, status);
    },
  );
}

