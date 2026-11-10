# AI Email Assistant

Local, zero-cost MCP backend for recruiter outreach. AI writing is performed by Claude Desktop or Google Antigravity; this backend will provide local data, validation, Gmail, and campaign tools as later phases are completed.

## Phase 1: MCP foundation

The server uses the official MCP SDK and the stdio transport. It currently exposes one safe tool:

- `get_system_status` — returns server health and the Phase 1 capability set.

No email, Gmail, recruiter, resume, or database operations are active yet.

## Requirements

- Node.js 20.19.3 or newer
- npm 10.8.2 or newer

## Install and verify

```powershell
npm install
npm test
npm start
```

`npm start` intentionally keeps running while an MCP client is connected. Diagnostic messages go to stderr only; stdout is reserved for MCP JSON-RPC.

## Claude Desktop configuration

Open Claude Desktop's **Settings → Developer → Edit Config** and add this server under `mcpServers`. Replace the path if the project is located elsewhere.

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

Restart Claude Desktop, then ask it to call `get_system_status`.

## Google Antigravity configuration

In Antigravity's MCP server settings, add a local **stdio** server with:

```json
{
  "command": "node",
  "args": ["C:\\Users\\nikhi\\Desktop\\ai email assistant\\src\\index.js"]
}
```

Save/reconnect the server and call `get_system_status`. The exact settings screen may vary by Antigravity version; use its local-MCP/stdio server entry rather than an HTTP URL.

## Security notes

- Do not commit `.env`, `credentials/`, uploaded resumes, SQLite databases, or logs.
- The server does not log secrets and has no shell or arbitrary filesystem tool.
- Future email sending will require explicit campaign approval.

