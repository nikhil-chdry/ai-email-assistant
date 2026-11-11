import { z } from "zod";

const PHASE = 10;

export function registerSystemTools(server) {
  server.registerTool(
    "get_system_status",
    {
      title: "Get system status",
      description:
        "Returns the local AI Email Assistant MCP server status and the capabilities available in the current development phase. Does not expose secrets, files, or credentials.",
      inputSchema: z.object({}).strict(),
    },
    async () => ({
      structuredContent: {
        status: "ready",
        server: "ai-email-assistant",
        version: "1.0.0",
        phase: PHASE,
        transport: "stdio",
        capabilities: {
          systemStatus: true,
          profileManagement: true,
          recruiterManagement: true,
          emailDraftManagement: true,
          gmailIntegration: true,
          singleEmailSending: true,
          campaignManagement: true,
          followUps: true,
          securityHardened: true,
          productionReady: true,
        },
        notes: [
          "Phase 10: Complete local AI Recruiter Outreach Assistant is production-ready.",
          "All reasoning and writing performed by client AI (Claude Desktop / Antigravity); no paid AI APIs used.",
          "Gmail operations run locally with minimum scopes and AES-256-GCM token encryption at rest.",
          "All destructive actions require explicit confirmation flags.",
          "Follow-up schedules operate locally only while this assistant server process is running.",
        ],
      },
      content: [
        {
          type: "text",
          text: "AI Email Assistant MCP server is ready (Phase 10 - Production Ready).",
        },
      ],
    }),
  );
}
