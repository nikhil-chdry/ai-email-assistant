import { z } from "zod";

function result(textContent, structuredContent) {
  return {
    content: [{ type: "text", text: textContent }],
    structuredContent,
  };
}

export function registerReplyTools(server, replyTrackingService) {
  server.registerTool(
    "check_replies",
    {
      title: "Check Gmail replies",
      description:
        "Reads Gmail outreach threads using gmail.readonly to detect recruiter responses. Matches incoming messages to sent outreach, stores timestamps and snippet metadata, updates recruiter status to 'replied', and automatically cancels any pending scheduled follow-ups.",
      inputSchema: z.object({}).strict(),
    },
    async () => {
      const res = await replyTrackingService.checkReplies();
      return result(res.message, res);
    },
  );

  server.registerTool(
    "schedule_followups",
    {
      title: "Schedule outreach follow-ups",
      description:
        "Schedules local follow-up reminders for contacted recruiters who have not yet replied. Note: Scheduled follow-ups run locally only while this MCP server process is active.",
      inputSchema: z
        .object({
          recruiterIds: z
            .array(z.number().int().positive())
            .optional()
            .describe(
              "Optional list of recruiter IDs. If omitted, schedules for all contacted recruiters who haven't replied.",
            ),
          daysDelay: z
            .number()
            .int()
            .min(1)
            .max(30)
            .default(4)
            .describe("Number of days after initial outreach to schedule the follow-up."),
          campaignId: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Optional campaign ID to associate with the follow-up."),
        })
        .strict(),
    },
    async (input) => {
      const res = await replyTrackingService.scheduleFollowups(input);
      return result(
        `Scheduled ${res.scheduledCount} follow-up reminders. Note: Follow-ups operate locally while server is running.`,
        res,
      );
    },
  );

  server.registerTool(
    "get_pending_followups",
    {
      title: "Get pending follow-ups",
      description:
        "Lists scheduled follow-ups that are awaiting draft generation. Explicitly notes that follow-up schedules run only while the local process is running.",
      inputSchema: z
        .object({
          dueOnly: z
            .boolean()
            .default(false)
            .describe("If true, filters to only return follow-ups that are currently due or past due."),
          campaignId: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Optional campaign ID filter."),
        })
        .strict(),
    },
    async (input) => {
      const res = replyTrackingService.getPendingFollowups(input);
      return result(
        `Retrieved ${res.totalPending} pending follow-ups (${res.dueCount} currently due).`,
        res,
      );
    },
  );

  server.registerTool(
    "generate_followup",
    {
      title: "Generate follow-up brief",
      description:
        "Builds a personalized follow-up writing brief for Claude Desktop or Antigravity based on original outreach and profile highlights. Refuses to generate automated follow-ups if the recruiter has already replied (especially interview invitations). Never sends email automatically.",
      inputSchema: z
        .object({
          recruiterId: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Recruiter ID to generate follow-up brief for. Required unless followupId is provided."),
          followupId: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Scheduled follow-up ID to generate draft brief for."),
          tone: z
            .enum(["polite", "concise", "professional"])
            .default("polite")
            .describe("Tone constraint for the follow-up brief."),
        })
        .strict()
        .refine((data) => data.recruiterId || data.followupId, {
          message: "Either recruiterId or followupId must be provided.",
        }),
    },
    async (input) => {
      const brief = await replyTrackingService.generateFollowup(input);
      return result(
        `Follow-up draft brief prepared for ${brief.recruiter.name} at ${brief.recruiter.company}. Compose draft in client; drafts are never sent automatically.`,
        brief,
      );
    },
  );

  server.registerTool(
    "classify_reply",
    {
      title: "Classify recruiter reply",
      description:
        "Records classification for a received recruiter reply: positive_response, rejection, interview_invitation, or other.",
      inputSchema: z
        .object({
          replyId: z.number().int().positive().describe("ID of the recruiter reply to classify."),
          classification: z
            .enum(["positive_response", "rejection", "interview_invitation", "other"])
            .describe("Classification category."),
          reason: z
            .string()
            .trim()
            .max(500)
            .default("")
            .describe("Brief reasoning for the classification."),
        })
        .strict(),
    },
    async (input) => {
      const res = await replyTrackingService.classifyReply(input);
      return result(res.message, res);
    },
  );
}

