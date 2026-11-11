# AI Email Assistant

A free, local MCP backend for managing recruiter outreach. It is designed for use from Claude Desktop and Google Antigravity, which perform the AI reasoning and writing. The backend handles deterministic local data operations, validation, and draft storage.

This project does not use Anthropic APIs, Gemini Developer APIs, paid hosting, paid databases, or paid recruiter-discovery services.

## Current scope: Phase 4

The following phases are complete:

1. MCP stdio server foundation.
2. Local SQLite candidate profile and PDF-resume management.
3. Recruiter CSV import and local contact management.
4. Client-side AI email-generation briefs and unsent draft management.

Gmail OAuth, sending, campaigns, reply detection, and follow-ups are deliberately not implemented yet. At this stage, the server cannot send an email.

## Architecture

```text
Claude Desktop / Google Antigravity
                │ MCP over stdio
                ▼
      Local Node.js MCP server
         ├── SQLite database: data/ai-email-assistant.sqlite
         ├── Protected resume storage: uploads/resumes/
         └── Local tools for profile, recruiters, and drafts
```

All application diagnostics go to stderr. Stdout is reserved exclusively for MCP JSON-RPC communication.

## Requirements

- Node.js 20.19.3 or newer
- npm 10.8.2 or newer
- Claude Desktop and/or Google Antigravity with local stdio MCP support

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

Reconnect the server and call `get_system_status`. The exact settings interface may vary by Antigravity release; choose a local stdio server rather than an HTTP server.

## Available MCP tools

| Area | Tools |
| --- | --- |
| System | `get_system_status` |
| Profile | `get_my_profile`, `update_my_profile`, `upload_resume`, `get_resume_information` |
| Recruiters | `create_recruiter`, `import_recruiters`, `list_recruiters`, `search_recruiters`, `filter_recruiters`, `validate_contacts`, `update_recruiter`, `delete_recruiter` |
| Email drafts | `generate_email`, `save_email_draft`, `get_email_drafts`, `update_email_draft`, `delete_email_draft` |

Every tool validates its input with Zod and returns structured results.

## Recommended workflow

1. Call `get_my_profile` and correct any user-provided profile information.
2. Call `upload_resume` with an explicit PDF path. The active resume becomes the primary evidence source for professional claims.
3. Add contacts with `create_recruiter`, or use `import_recruiters` with `dryRun: true` before the real import.
4. Use `validate_contacts` to check syntax. A syntax result is not deliverability or ownership verification.
5. Call `generate_email` with a recruiter and one of these templates: `sde_intern`, `backend_developer`, `full_stack_developer`, `software_engineer`, `ml_engineer`, or `ai_engineer`.
6. Have Claude Desktop or Antigravity write the email from the returned evidence and instructions. It must not invent experience, certifications, achievements, or company connections.
7. Save the completed copy using `save_email_draft`. Draft operations are local only and never send an email.

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
- No secrets, OAuth tokens, resume paths, or arbitrary shell/filesystem operations are exposed through MCP.
- Never commit `.env`, `credentials/`, uploads, databases, or logs.

## Quality checks

```powershell
npm test
npm audit --omit=dev
```

The Phase 4 suite covers MCP discovery, stdout safety, profile management, PDF import, recruiter import and duplicate handling, format-only validation, and email draft lifecycle operations.

## Next: Phase 5

Phase 5 will add Google OAuth and Gmail connection status only. It will use the minimum scopes (`gmail.send` and `gmail.readonly`), store credentials locally, avoid passwords, and not send any outreach email until later phases add explicit campaign approval.
