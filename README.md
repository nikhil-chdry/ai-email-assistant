# AI Email Assistant

A free, local MCP backend for managing recruiter outreach. It is designed for use from Claude Desktop and Google Antigravity, which perform the AI reasoning and writing. The backend handles deterministic local data operations, validation, Gmail OAuth, draft storage, and controlled single-email sending.

This project does not use Anthropic APIs, Gemini Developer APIs, paid hosting, paid databases, or paid recruiter-discovery services.

## Current scope: Phase 6

The following phases are complete:

1. MCP stdio server foundation.
2. Local SQLite candidate profile and PDF-resume management.
3. Recruiter CSV import and local contact management.
4. Client-side AI email-generation briefs and unsent draft management.
5. Google OAuth 2.0 integration and Gmail connection status with AES-256-GCM encrypted token storage.
6. Controlled single test-email sending with MIME message construction, optional active-resume PDF attachment, and delivery result logging.

Automated outreach campaigns, reply detection, and automated follow-ups are deliberately reserved for future phases. At Phase 6, bulk or campaign sending is not allowed.

## Architecture

```text
Claude Desktop / Google Antigravity
                │ MCP over stdio
                ▼
      Local Node.js MCP server
         ├── SQLite database: data/ai-email-assistant.sqlite
         ├── Protected resume storage: uploads/resumes/
         ├── Encrypted OAuth token vault: AES-256-GCM at rest
         ├── Transient loopback callback server (http://127.0.0.1:54321/callback)
         ├── RFC 2822 MIME message builder
         └── Local tools for profile, recruiters, drafts, OAuth, and test sending
```

All application diagnostics go to stderr. Stdout is reserved exclusively for MCP JSON-RPC communication.

## Requirements

- Node.js 20.19.3 or newer
- npm 10.8.2 or newer
- Claude Desktop and/or Google Antigravity with local stdio MCP support
- Google Cloud account (free tier) with Gmail API enabled

## Install and test

```powershell
npm install
npm test
```

Start the server manually only for diagnostics:

```powershell
npm start
```

An MCP client normally starts the server itself using the configuration below.

## Connect an MCP client

### Claude Desktop

Open **Settings → Developer → Edit Config**, then add the server under `mcpServers`. Update the path if you move this project.

```json
{
  "mcpServers": {
    "ai-email-assistant": {
      "command": "node",
      "args": ["C:\\Users\\nikhi\\Desktop\\ai email assistant\\src\\index.js"]
    }
  }
}
```

Restart Claude Desktop and ask it to call `get_system_status`.

### Google Antigravity

In Antigravity's MCP settings, add a local **stdio** server:

```json
{
  "command": "node",
  "args": ["C:\\Users\\nikhi\\Desktop\\ai email assistant\\src\\index.js"]
}
```

Reconnect the server and call `get_system_status`.

## Available MCP tools

| Area | Tools | Description |
| --- | --- | --- |
| System | `get_system_status` | Server health, version, phase, and capabilities. |
| Profile | `get_my_profile`, `update_my_profile`, `upload_resume`, `get_resume_information` | Candidate profile and verified resume PDF text extraction. |
| Recruiters | `create_recruiter`, `import_recruiters`, `list_recruiters`, `search_recruiters`, `filter_recruiters`, `validate_contacts`, `update_recruiter`, `delete_recruiter` | Contact management with format-only validation and duplicate avoidance. |
| Email drafts | `generate_email`, `save_email_draft`, `get_email_drafts`, `update_email_draft`, `delete_email_draft` | Client-side personalized writing briefs and local unsent draft lifecycle. |
| Gmail OAuth | `connect_gmail`, `get_gmail_status` | Google OAuth 2.0 desktop connection, token encryption at rest, automatic token refresh, and connection status. |
| Email sending | `send_test_email` | Controlled single test-email sending with confirmation, MIME construction, and optional active-resume attachment. |

Every tool validates its input with Zod and returns structured results.

## Google Cloud OAuth 2.0 Setup Guide

This assistant connects to your Gmail account using the minimum necessary Google OAuth scopes:
- `https://www.googleapis.com/auth/gmail.send`
- `https://www.googleapis.com/auth/gmail.readonly`

Gmail passwords are never requested or stored.

### Step 1: Create a Google Cloud Project

1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new project (e.g., `ai-email-assistant`).
3. Select the newly created project.

### Step 2: Enable the Gmail API

1. In the navigation menu, go to **APIs & Services → Library**.
2. Search for **Gmail API** and click **Enable**.

### Step 3: Configure the OAuth Consent Screen

1. Navigate to **APIs & Services → OAuth consent screen**.
2. Select **External** and click **Create**.
3. Fill in the App Name (e.g. `AI Recruiter Assistant`) and user support email.
4. On the **Scopes** page, add the two minimum required scopes:
   - `https://www.googleapis.com/auth/gmail.send`
   - `https://www.googleapis.com/auth/gmail.readonly`
5. On the **Test users** page, click **+ ADD USERS** and enter your personal Gmail address.
6. Save and finish.

### Step 4: Create OAuth 2.0 Client Credentials

1. Go to **APIs & Services → Credentials**.
2. Click **Create Credentials → OAuth client ID**.
3. Select **Desktop app** (or **Web application** with redirect URI `http://127.0.0.1:54321/callback`).
4. Click **Create** and copy your **Client ID** and **Client Secret**.

### Step 5: Configure Environment Variables

1. Copy `.env.example` to `.env`:
   ```powershell
   Copy-Item .env.example .env
   ```
2. Generate a secure 32-byte encryption key:
   ```powershell
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
3. Open `.env` and fill in the values:
   ```env
   GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=your-client-secret
   GOOGLE_REDIRECT_URI=http://127.0.0.1:54321/callback
   TOKEN_ENCRYPTION_KEY=your-generated-hex-key-here
   ```

### Step 6: Connect Gmail via MCP

1. Ask Claude Desktop or Antigravity to call `connect_gmail`.
2. The tool starts a transient local callback listener on `http://127.0.0.1:54321/callback` and returns the authorization URL.
3. Open the URL in your browser, select your Google account, and grant the requested permissions.
4. Google redirects to the local callback listener, which automatically captures the authorization code, encrypts your tokens with AES-256-GCM, and closes the listener.
5. Verify your connection at any time by calling `get_gmail_status`.

---

## Controlled Single Email Sending (Phase 6)

Phase 6 introduces single test-email sending via the `send_test_email` tool.

### Sending Rules & Safety Controls:
1. **Explicit Confirmation**: Sending an email strictly requires `confirmSend: true`. If omitted or `false`, the tool returns a preview and does not send anything.
2. **No Campaigns in Phase 6**: Only single test emails can be sent. Campaign outreach is blocked until Phase 7.
3. **MIME Compliance**: Constructs RFC 2822 multipart/alternative (plain text + HTML) and multipart/mixed (with PDF attachment) messages with correct UTF-8 RFC 2047 header encoding.
4. **Active Resume Attachment**: Pass `attachActiveResume: true` to attach the verified candidate PDF resume. File size is checked against the 10 MB limit and path traversal protections prevent access outside `uploads/resumes/`. Local file paths are never exposed in tool outputs.
5. **Saved Draft Integration**: You can supply `draftId` to load the subject and body from an existing unsent draft.
6. **Audit and Result Tracking**: Every sent message ID, thread ID, timestamp, and recipient are recorded in the `sent_emails` and `activity_logs` tables.

Example usage:
```json
{
  "recipientEmail": "your-own-email@gmail.com",
  "subject": "Test Outreach",
  "bodyText": "Hello, this is a test email sent from AI Email Assistant.",
  "attachActiveResume": true,
  "confirmSend": true
}
```

---

## Recommended workflow

1. Call `get_my_profile` and correct any user-provided profile information.
2. Call `upload_resume` with an explicit PDF path. The active resume becomes the primary evidence source for professional claims.
3. Add contacts with `create_recruiter`, or use `import_recruiters` with `dryRun: true` before the real import.
4. Use `validate_contacts` to check syntax. A syntax result is not deliverability or ownership verification.
5. Call `generate_email` with a recruiter and one of these templates: `sde_intern`, `backend_developer`, `full_stack_developer`, `software_engineer`, `ml_engineer`, or `ai_engineer`.
6. Have Claude Desktop or Antigravity write the email from the returned evidence and instructions.
7. Save the completed copy using `save_email_draft`.
8. Call `connect_gmail` to establish the OAuth connection.
9. Call `get_gmail_status` to verify connection and token status.
10. Call `send_test_email` with your own email and `confirmSend: true` to verify end-to-end delivery before any outreach campaigns.

### Recruiter CSV format

Required columns:

```csv
name,email
```

Optional columns: `company`, `designation`, `job_role`, `company_website`, `public_professional_info`, and `source`.

Existing emails and duplicate emails within the same CSV are skipped case-insensitively. The importer never invents recruiter email addresses.

## Data and security

- SQLite data is local at `data/ai-email-assistant.sqlite` and is ignored by Git.
- Resumes must be explicit local PDF paths, are limited to 10 MB, checked for a PDF signature, parsed locally, and copied to protected local storage.
- Uploading a replacement resume requires `confirmReplace: true`.
- Recruiter deletion and draft deletion require explicit confirmation.
- Stored recruiter email checks are format-only; no tool claims an address is deliverable or owned by the recruiter.
- Google OAuth access and refresh tokens are encrypted at rest using AES-256-GCM with a user-configured key (`TOKEN_ENCRYPTION_KEY`).
- Token values and client secrets are never returned in MCP responses or written to stderr logs.
- Disconnecting Gmail requires explicit `confirmDisconnect: true`.
- Test email sending requires explicit `confirmSend: true`.
- Stored `sent_emails` records store recipient, subject, Gmail message ID, delivery status, and original attachment filename (never local storage paths or tokens).
- Never commit `.env`, `credentials/`, uploads, databases, or logs.

## Quality checks

```powershell
npm test
npm audit --omit=dev
```

The test suite covers:
- MCP discovery and stdio purity
- Profile management and PDF import
- Recruiter import and duplicate prevention
- Email draft lifecycle operations
- AES-256-GCM token encryption and key derivation
- Google OAuth authorization URL generation, code exchange, token refresh, and callback handling
- RFC 2822 MIME message construction (text, HTML, attachments)
- Resume path traversal protection and attachment validation
- Controlled single test email sending, confirmSend enforcement, and delivery result logging

## Next: Phase 7

Phase 7 will implement campaign management with immutable campaign approval (`create_campaign`, `preview_campaign`, `approve_campaign`, `send_campaign`, `pause_campaign`, `resume_campaign`, `stop_campaign`, `get_campaign_report`), suppression lists, duplicate send prevention, and controlled rate limiting.
