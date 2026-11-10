import { z } from "zod";

const PHASE = 1;

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
          profileManagement: false,
          recruiterManagement: false,
          gmailIntegration: false,
          campaignManagement: false,
          followUps: false,
        },
        notes: [
          "Phase 1 foundation is active.",
          "No Gmail account, recruiter data, resume, or campaign data is accessed in this phase.",
        ],
      },
      content: [
        {
          type: "text",
          text: "AI Email Assistant MCP server is ready (Phase 1).",
        },
      ],
    }),
  );
}

