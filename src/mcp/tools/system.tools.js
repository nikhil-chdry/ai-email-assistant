import { z } from "zod";

const PHASE = 6;

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
          campaignManagement: false,
          followUps: false,
        },
        notes: [
          "Phase 6 single email sending and resume attachment support is active (send_test_email).",
          "Automated campaign execution and reply tracking are disabled until Phases 7 and 8.",
        ],
      },
      content: [
        {
          type: "text",
          text: "AI Email Assistant MCP server is ready (Phase 6).",
        },
      ],
    }),
  );
}
