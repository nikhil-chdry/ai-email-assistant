# AI Email Assistant

A 100% free, local, private Model Context Protocol (MCP) server for managing end-to-end recruiter outreach. Designed for seamless use with **Claude Desktop** and **Google Antigravity**, which execute all AI reasoning, personalization, and email drafting.

The local Node.js backend deterministically manages local data storage, schema validation, candidate resumes, contact lists, draft persistence, Gmail OAuth 2.0 operations, immutable campaign controls, Gmail reply tracking, and follow-up scheduling.

> [!IMPORTANT]
> **Zero Paid APIs or Services Required**: This project strictly uses local tools and free developer tiers. It requires **no** Anthropic API key, **no** Gemini Developer API key, **no** paid AI subscriptions, **no** paid databases, and **no** paid cloud infrastructure.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Prerequisites & System Requirements](#prerequisites--system-requirements)
3. [Windows Installation & Verification](#windows-installation--verification)
4. [Environment Variables & Token Encryption](#environment-variables--token-encryption)
5. [Google Cloud OAuth 2.0 Setup Guide](#google-cloud-oauth-20-setup-guide)
6. [MCP Client Setup (Claude Desktop & Google Antigravity)](#mcp-client-setup)
7. [Complete MCP Tools Reference](#complete-mcp-tools-reference)
8. [End-to-End Operational Workflows](#end-to-end-operational-workflows)
   - [Candidate Profile & PDF Resume](#1-candidate-profile--pdf-resume-workflow)
   - [Recruiter Import & Management](#2-recruiter-csv-import--management-workflow)
   - [Client-Side AI Email Drafting](#3-client-side-ai-email-drafting-workflow)
   - [Gmail OAuth Connection & Test Send](#4-gmail-oauth-connection--test-send-workflow)
   - [Outreach Campaign Approval & Execution](#5-outreach-campaign-approval--automation-workflow)
   - [Reply Detection & Follow-Up Briefs](#6-reply-detection--follow-up-management-workflow)
9. [Operational Limitations](#operational-limitations)
10. [Security & Privacy Architecture](#security--privacy-architecture)
11. [Troubleshooting Guide](#troubleshooting-guide)
12. [Project Structure](#project-structure)

---

## Architecture Overview

```text
       ┌─────────────────────────────────────────────────────────┐
       │         AI Clients (Reasoning & Writing Layer)          │
       │        Claude Desktop   /   Google Antigravity           │
       └────────────────────────────┬────────────────────────────┘
                                    │ stdio (JSON-RPC)
                                    ▼
       ┌─────────────────────────────────────────────────────────┐
       │         Local AI Email Assistant MCP Server             │
       │                    (Node.js 20+)                        │
       │                                                         │
       │  ┌────────────────────┐      ┌───────────────────────┐  │
       │  │  34 Strict MCP     │      │  AES-256-GCM Vault    │  │
       │  │  Tools (Zod Schema)│      │  (Token Encryption)   │  │
       │  └─────────┬──────────┘      └───────────┬───────────┘  │
       │            │                             │              │
       │  ┌─────────▼──────────┐      ┌───────────▼───────────┐  │
       │  │  Local SQLite DB   │      │  RFC 2822 MIME &      │  │
       │  │  (sql.js Engine)   │      │  Attachment Builder   │  │
       │  └─────────┬──────────┘      └───────────┬───────────┘  │
       │            │                             │              │
       │  ┌─────────▼──────────┐      ┌───────────▼───────────┐  │
       │  │  Local PDF & CSV   │      │  Transient Loopback   │  │
       │  │  Secure Parsers    │      │  OAuth Server (:54321)│  │
       │  └────────────────────┘      └───────────┬───────────┘  │
       └──────────────────────────────────────────┼──────────────┘
                                                  │ HTTPS
                                                  ▼
                                      ┌───────────────────────┐
                                      │    Google Gmail API   │
                                      │ (gmail.send, readonly)│
                                      └───────────────────────┘
```

- **Purity of stdio**: Standard output (`stdout`) is reserved strictly for MCP JSON-RPC protocol frames. All diagnostic, lifecycle, and debug messages go exclusively to standard error (`stderr`).
- **No Third-Party Cloud Bloat**: All Gmail API communication and MIME composition are handled natively via Node.js built-ins (`node:crypto`, `node:http`, and `globalThis.fetch`), completely avoiding heavy, vulnerable SDK dependencies.

---

## Prerequisites & System Requirements

- **Operating System**: Windows 10/11 (or macOS / Linux).
- **Node.js**: `v20.19.3` or newer (LTS recommended).
- **npm**: `v10.8.2` or newer.
- **Client**: Claude Desktop (latest) or Google Antigravity with local MCP stdio support.
- **Google Account**: Any free personal Gmail account with Google Cloud access.

---

## Windows Installation & Verification

1. **Open PowerShell** and navigate to your project directory:
   ```powershell
   cd "C:\Users\nikhi\Desktop\ai email assistant"
   ```

2. **Install project dependencies**:
   ```powershell
   npm install
   ```

3. **Execute the automated test suite**:
   ```powershell
   npm test
   ```
   *Expected result: 6 test suites passed, 47/47 tests passed.*

4. **Verify zero production vulnerabilities**:
   ```powershell
   npm audit --omit=dev
   ```
   *Expected result: `found 0 vulnerabilities`.*

---

## Environment Variables & Token Encryption

The assistant protects Google OAuth access and refresh tokens at rest in SQLite using **AES-256-GCM** authenticated encryption.

1. **Create your local `.env` file**:
   ```powershell
   Copy-Item .env.example .env
   ```

2. **Generate a cryptographically secure 256-bit encryption key**:
   ```powershell
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

3. **Configure `.env`**:
   ```env
   # Google OAuth 2.0 Credentials
   GOOGLE_CLIENT_ID=your-google-client-id.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=your-google-client-secret
   GOOGLE_REDIRECT_URI=http://127.0.0.1:54321/callback

   # Local AES-256-GCM Key (Derived via SHA-256)
   TOKEN_ENCRYPTION_KEY=your-generated-hex-key-here
   ```

> [!CAUTION]
> Never commit `.env`, `data/`, or `uploads/` to version control. They are strictly ignored by `.gitignore`.

---

## Google Cloud OAuth 2.0 Setup Guide

To send outreach emails and read replies without passwords, create a free OAuth 2.0 Client in Google Cloud Console.

### Step 1: Create a Google Cloud Project
1. Navigate to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new project (e.g., `ai-email-assistant`).

### Step 2: Enable the Gmail API
1. Go to **APIs & Services → Library**.
2. Search for **Gmail API** and click **Enable**.

### Step 3: Configure OAuth Consent Screen
1. Go to **APIs & Services → OAuth consent screen**.
2. Choose **External** and click **Create**.
3. Set **App Name** (e.g., `AI Recruiter Assistant`) and provide your user support email.
4. On the **Scopes** page, click **Add or Remove Scopes** and select:
   - `https://www.googleapis.com/auth/gmail.send`
   - `https://www.googleapis.com/auth/gmail.readonly`
5. On the **Test users** page:
   > [!IMPORTANT]
   > Click **+ ADD USERS** and enter your personal Gmail address. In Google Cloud "Testing" mode, any login attempt without adding your email here will fail with `Error 403: access_denied`.
6. Save and finish.

### Step 4: Create OAuth 2.0 Client Credentials
1. Go to **APIs & Services → Credentials**.
2. Click **Create Credentials → OAuth client ID**.
3. Select **Desktop app** (or **Web application** with Authorized Redirect URI: `http://127.0.0.1:54321/callback`).
4. Click **Create** and paste the **Client ID** and **Client Secret** into your `.env` file.

---

## MCP Client Setup

### Claude Desktop Configuration

Edit your Claude Desktop configuration file (`%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "ai-email-assistant": {
      "command": "node",
      "args": [
        "C:\\Users\\nikhi\\Desktop\\ai email assistant\\src\\index.js"
      ]
    }
  }
}
```

### Google Antigravity Configuration

In Antigravity's **MCP Settings** (or workspace configuration):

```json
{
  "mcpServers": {
    "ai-email-assistant": {
      "command": "node",
      "args": [
        "C:\\Users\\nikhi\\Desktop\\ai email assistant\\src\\index.js"
      ]
    }
  }
}
```

Restart Claude Desktop or Antigravity and ask:
> *"Check the assistant system status."*

---

## Complete MCP Tools Reference

The server exposes **34 deterministic MCP tools**, each with strict Zod validation schemas:

| Category | Tool | Parameters | Description |
|---|---|---|---|
| **System** | `get_system_status` | *None* | Verifies server readiness, version, active phase (Phase 10), and enabled capabilities. |
| **Profile** | `get_my_profile` | *None* | Returns stored candidate profile and resume link status. |
| | `update_my_profile` | `fullName`, `college`, `degree`, `graduationBatch`, `careerPreference`, `technicalSkills`, `projects`, `research` | Updates candidate background info. |
| | `upload_resume` | `sourcePath`, `confirmReplace` | Copies local PDF resume to safe storage, validates `%PDF-` signature, and parses text locally. |
| | `get_resume_information` | *None* | Returns parsed resume metadata and full extracted text. |
| **Recruiters** | `create_recruiter` | `name`, `email`, `company`, `designation`, `jobRole`, etc. | Adds a single recruiter contact manually. |
| | `import_recruiters` | `sourcePath`, `defaultSource`, `dryRun` | Imports contacts from a local CSV with duplicate skipping and format validation. |
| | `list_recruiters` | `limit`, `offset`, `company`, `jobRole`, `outreachStatus` | Lists recruiters with pagination and status filters. |
| | `search_recruiters` | `query`, `limit`, `offset` | Fast search across names, emails, companies, and roles. |
| | `filter_recruiters` | `company`, `jobRole`, `outreachStatus` | Multi-field filtering for targeted outreach. |
| | `validate_contacts` | `recruiterIds` (optional) | Syntax-checks email addresses (format-only; never claims deliverability). |
| | `update_recruiter` | `id`, *updates* | Updates contact details and status. |
| | `delete_recruiter` | `id`, `confirmDelete: true` | Permanently deletes a recruiter contact (requires confirmation). |
| **Drafts** | `generate_email` | `recruiterId`, `template`, `companyInformation` | Generates a truthful writing brief for the client AI. |
| | `save_email_draft` | `recruiterId`, `template`, `subject`, `body`, `companyInformation` | Saves an AI-written outreach draft locally without sending. |
| | `get_email_drafts` | `recruiterId`, `limit`, `offset` | Lists unsent drafts saved in SQLite. |
| | `update_email_draft` | `id`, `subject`, `body`, `template`, `companyInformation` | Updates draft text. |
| | `delete_email_draft` | `id`, `confirmDelete: true` | Deletes an unsent draft (requires confirmation). |
| **Gmail OAuth** | `connect_gmail` | `authorizationCode`, `redirectUri`, `startLocalListener`, `disconnect`, `confirmDisconnect` | Starts transient local listener (`:54321`), generates auth URL, or exchanges token. |
| | `get_gmail_status` | *None* | Returns Gmail connection state and email without exposing secret tokens. |
| **Sending** | `send_test_email` | `recipientEmail`, `recipientName`, `subject`, `bodyText`, `bodyHtml`, `draftId`, `attachActiveResume`, `confirmSend: true` | Sends a single test email through Gmail with optional PDF attachment. |
| **Campaigns** | `create_campaign` | `name`, `description`, `emailDraftId`, `recruiterIds`, `attachActiveResume`, `batchSize`, `delaySecondsBetweenEmails` | Creates a new outreach campaign in draft state. |
| | `preview_campaign` | `campaignId` | Inspects recipient list, suppression checks, and attachments. |
| | `approve_campaign` | `campaignId`, `confirmApproval: true` | Locks an immutable campaign version with a SHA-256 approval hash. |
| | `send_campaign` | `campaignId`, `maxEmailsToSend`, `confirmSend: true` | Dispatches approved campaign batches with rate control and deduplication. |
| | `pause_campaign` | `campaignId` | Pauses active campaign sending. |
| | `resume_campaign` | `campaignId` | Resumes a paused campaign after verifying approval hash integrity. |
| | `stop_campaign` | `campaignId`, `confirmStop: true` | Permanently cancels remaining campaign dispatches. |
| | `get_campaign_report` | `campaignId` | Generates progress, delivery stats, and recipient breakdown. |
| **Replies & Follow-ups** | `check_replies` | *None* | Reads Gmail threads via `gmail.readonly`, matches replies, and cancels follow-ups. |
| | `schedule_followups` | `recruiterIds`, `daysDelay` (default: 4), `campaignId` | Queues local reminders for contacted recruiters who have not replied. |
| | `get_pending_followups` | `dueOnly`, `campaignId` | Lists pending follow-up schedules. |
| | `generate_followup` | `recruiterId`, `followupId`, `tone` | Prepares draft-only follow-up brief (refuses if interview invite detected). |
| | `classify_reply` | `replyId`, `classification`, `reason` | Stores AI classification (`positive_response`, `rejection`, `interview_invitation`, `other`). |

---

## End-to-End Operational Workflows

### 1. Candidate Profile & PDF Resume Workflow
1. Call `get_my_profile` to inspect default candidate fields.
2. Update background details using `update_my_profile`.
3. Upload your official resume PDF:
   ```json
   {
     "sourcePath": "C:\\Users\\nikhi\\Documents\\My-Resume.pdf"
   }
   ```
   The backend validates that the file exists, is under 10 MB, possesses a valid `%PDF-` signature, parses the text via PDF.js, and copies it to protected local storage (`uploads/resumes/`).

### 2. Recruiter CSV Import & Management Workflow
1. Prepare a recruiter CSV (`recruiters.csv`):
   ```csv
   name,email,company,designation,job_role
   Sarah Connor,sarah.recruiter@cyberdyne.example,Cyberdyne Systems,Tech Recruiter,Full Stack Engineer
   John Matrix,matrix.talent@matrix.example,Matrix Tech,Lead Recruiter,Backend Developer
   ```
2. Run a dry run to check headers and duplicates:
   ```json
   { "sourcePath": "C:\\Users\\nikhi\\Documents\\recruiters.csv", "dryRun": true }
   ```
3. Import contacts with `dryRun: false`. Duplicates and invalid email formats are automatically filtered.

### 3. Client-Side AI Email Drafting Workflow
Supported templates:
- `sde_intern`
- `backend_developer`
- `full_stack_developer`
- `software_engineer`
- `ml_engineer`
- `ai_engineer`

1. Call `generate_email` with `recruiterId` and target `template`.
2. The local server returns a structured writing brief containing recruiter details, candidate skills, verified resume claims, and stylistic constraints.
3. **Claude or Antigravity writes the email body directly in the conversation**.
4. Save the generated email using `save_email_draft`:
   ```json
   {
     "recruiterId": 1,
     "template": "backend_developer",
     "subject": "Inquiry: Backend Engineering Opportunities at Cyberdyne",
     "body": "Hi Sarah,\n\nI hope this finds you well..."
   }
   ```
   Drafts are safely stored in SQLite in unsent state.

### 4. Gmail OAuth Connection & Test Send Workflow
1. Connect your Gmail account:
   - Call `connect_gmail`.
   - The tool starts a local callback server at `http://127.0.0.1:54321/callback` and returns an authorization URL.
   - Click the link, sign in to Google, grant permissions, and the callback listener automatically captures tokens, encrypts them via AES-256-GCM, and shuts down.
2. Verify connection status with `get_gmail_status`.
3. Send a test email to your own inbox:
   ```json
   {
     "recipientEmail": "your-personal-email@gmail.com",
     "subject": "Test Verification Email",
     "bodyText": "Hello! Testing AI Email Assistant with resume attachment.",
     "attachActiveResume": true,
     "confirmSend": true
   }
   ```

### 5. Outreach Campaign Approval & Automation Workflow
1. **Create Campaign**: Call `create_campaign` linking an approved email draft and selected recruiters.
2. **Preview**: Call `preview_campaign` to inspect recipient eligibility, draft content, resume attachment presence, and suppression list filtering.
3. **Cryptographic Approval**:
   ```json
   {
     "campaignId": 1,
     "confirmApproval": true
   }
   ```
   The backend generates a SHA-256 hash over the campaign version, draft subject, body, attachment status, and recipient list. Any subsequent modification to the draft invalidates the approval hash.
4. **Send Batches**:
   ```json
   {
     "campaignId": 1,
     "maxEmailsToSend": 10,
     "confirmSend": true
   }
   ```
   Emails are dispatched sequentially with configurable rate delays (default 2s) to prevent spam flags. Duplicate sends are strictly blocked.
5. **Campaign Controls**: Use `pause_campaign`, `resume_campaign`, `stop_campaign`, or `get_campaign_report` at any time.

### 6. Reply Detection & Follow-Up Management Workflow
1. **Detect Replies**: Call `check_replies`.
   - Uses `gmail.readonly` to inspect sent threads.
   - Filters out outgoing candidate messages.
   - Extracts incoming recruiter responses into `recruiter_replies`.
   - **Automatic Follow-Up Cancellation**: Automatically cancels any scheduled follow-up for that recruiter (`status = 'cancelled'`, `cancel_reason = 'reply_received'`).
2. **Classify Replies**: Call `classify_reply` (`positive_response`, `rejection`, `interview_invitation`, `other`).
3. **Schedule Follow-Ups**: Call `schedule_followups` to queue reminders (e.g. 4 days later) for recruiters who have not replied.
4. **Generate Follow-Up Briefs**: Call `generate_followup`.
   - **Safety Enforcement**: Strictly refuses to generate automated follow-ups if an interview invitation or reply was received.
   - Produces a polite, concise writing brief (50–80 words) for the client AI to compose. Follow-ups are **never sent automatically**.

---

## Operational Limitations

> [!WARNING]
> **Process Lifetime Limitation**: Scheduled follow-up reminders operate purely in local SQLite memory and check-queues. **They execute only while this MCP server process is running.** If Claude Desktop or Antigravity is closed, timers do not trigger in the background. Simply call `get_pending_followups` upon starting your session to review all due items.

- **Email Deliverability**: Stored email validations check format and syntax only; no local tool can guarantee mailbox existence without sending.
- **Quota Compliance**: Daily sending volume adheres strictly to standard Google Gmail consumer / Workspace API limits (typically 500–2,000 emails/day).

---

## Security & Privacy Architecture

- **Zero Secret Exposure**: Access tokens, refresh tokens, Google client secrets, encryption keys, and raw PDF storage paths are never logged to `stderr` or included in MCP tool response JSON.
- **Authenticated Encryption**: OAuth tokens in `data/ai-email-assistant.sqlite` are protected by AES-256-GCM. Tampering with any byte causes authenticated decryption to fail.
- **Path Traversal Defenses**: Uploads and imports resolve strictly against root directories with `%PDF-` signature verification and filename sanitization.
- **Explicit Confirmation Flags**: Destructive actions (`delete_recruiter`, `delete_email_draft`, `connect_gmail({ disconnect })`, `stop_campaign`) and email transmissions (`send_test_email`, `send_campaign`) require explicit boolean confirmation (`confirmSend: true`, `confirmDelete: true`).
- **Suppression List Enforcement**: Contacts marked `do_not_contact` or present in `suppression_list` are prevented from receiving campaign outreach.

---

## Troubleshooting Guide

### 1. `Error 403: access_denied` during Google Sign-In
- **Cause**: Google Cloud OAuth consent screen is in **Testing** mode and your Gmail address has not been added to the authorized testers list.
- **Fix**: Open [Google Cloud Console](https://console.cloud.google.com/) → **APIs & Services → OAuth consent screen → Test users**, click **+ ADD USERS**, enter your Gmail address, and click **Save**.

### 2. Callback Port `54321` Already in Use
- **Cause**: A lingering process or previous instance is holding port 54321.
- **Fix**: Open PowerShell and run:
  ```powershell
  Get-Process -Id (Get-NetTCPConnection -LocalPort 54321).OwningProcess | Stop-Process -Force
  ```

### 3. Resume Upload Fails with "Not a valid PDF file"
- **Cause**: The selected file either does not have a `.pdf` extension or is missing the standard `%PDF-` header signature.
- **Fix**: Open the resume in Adobe Acrobat or browser and re-export as a standard PDF.

### 4. Campaign Sending Blocked: "Campaign approval is invalid"
- **Cause**: The underlying email draft text was edited after the campaign was approved.
- **Fix**: Call `preview_campaign` to inspect changes, then call `approve_campaign` with `confirmApproval: true` to generate a new approval hash.

---

## Project Structure

```text
ai-email-assistant/
├── .env.example                       # Documented environment variable template
├── .gitignore                         # Excludes node_modules, data/, uploads/, .env
├── package.json                       # ES Modules project definition & scripts
├── README.md                          # Comprehensive production guide
├── src/
│   ├── index.js                       # MCP stdio entry point
│   ├── database/
│   │   ├── connection.js              # sql.js SQLite connection & migration runner
│   │   └── migrations/
│   │       ├── 001-initial-schema.js  # Candidate profile table
│   │       ├── 002-recruiters.js      # Recruiter contacts table & indexes
│   │       ├── 003-email-drafts.js    # Unsent email drafts table
│   │       ├── 004-gmail-tokens.js    # Encrypted token vault & activity logs
│   │       ├── 005-sent-emails.js     # Sent message history & delivery log
│   │       ├── 006-campaigns.js       # Campaigns, recipients, & suppression list
│   │       └── 007-replies-and-followups.js # Recruiter replies & follow-up queue
│   ├── mcp/
│   │   ├── server.js                  # MCP server factory & tool registration
│   │   └── tools/
│   │       ├── campaign.tools.js      # Campaign management tools
│   │       ├── email.tools.js         # Email drafting & brief tools
│   │       ├── gmail.tools.js         # OAuth connect & status tools
│   │       ├── profile.tools.js       # Profile & resume tools
│   │       ├── recruiter.tools.js     # Recruiter management & CSV tools
│   │       ├── reply.tools.js         # Reply checking & follow-up tools
│   │       ├── send.tools.js          # Single test email sending tools
│   │       └── system.tools.js        # System status & readiness tool
│   ├── services/
│   │   ├── campaign.service.js        # Campaign lifecycle, hashes, & batches
│   │   ├── email-draft.service.js     # Draft templates & writing briefs
│   │   ├── email-sending.service.js   # Single send operations & validation
│   │   ├── gmail-oauth.service.js     # OAuth flow, loopback server, & refresh
│   │   ├── profile.service.js         # Candidate profile & resume storage
│   │   ├── recruiter.service.js       # Recruiter search, filter, & deduplication
│   │   └── reply-tracking.service.js  # Thread matching & follow-up rules
│   └── utils/
│       ├── crypto.js                  # AES-256-GCM encryption/decryption
│       ├── csv-parser.js              # Safe recruiter CSV parser
│       ├── logger.js                  # Stderr-only diagnostic logger
│       ├── mime-builder.js            # RFC 2822 multipart MIME builder
│       └── pdf-parser.js              # Local PDF text extraction
└── tests/
    ├── campaign.test.js               # Campaign approvals, batches, & controls
    ├── email-sending.test.js          # Single send & MIME validation
    ├── gmail-oauth.test.js            # OAuth exchange, encryption, & refresh
    ├── reply-tracking.test.js         # Reply detection & follow-up cancellation
    ├── security-hardening.test.js     # Traversal, schema rejection, & audit tests
    └── system-status.test.js          # Server startup & tool discovery
```
