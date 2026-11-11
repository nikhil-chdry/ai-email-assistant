import { z } from "zod";

function result(textContent, structuredContent) {
  return {
    content: [{ type: "text", text: textContent }],
    structuredContent,
  };
}

export function registerCampaignTools(server, campaignService) {
  server.registerTool(
    "create_campaign",
    {
      title: "Create outreach campaign",
      description:
        "Creates a new outreach campaign in 'draft' status by selecting an existing email draft and recruiters. Deduplicates recipients and filters out contacts marked do_not_contact. Campaigns remain in draft until explicitly approved.",
      inputSchema: z
        .object({
          name: z.string().trim().min(1).max(200).describe("Descriptive name for the campaign."),
          description: z
            .string()
            .trim()
            .max(1_000)
            .optional()
            .describe("Optional campaign description or notes."),
          emailDraftId: z
            .number()
            .int()
            .positive()
            .describe("ID of the saved email draft to use as the message template."),
          recruiterIds: z
            .array(z.number().int().positive())
            .optional()
            .describe(
              "Optional list of recruiter IDs. If omitted, selects all eligible recruiters with status 'new' and valid email format.",
            ),
          attachActiveResume: z
            .boolean()
            .default(false)
            .describe("Whether to attach the active candidate PDF resume to outreach emails."),
          batchSize: z
            .number()
            .int()
            .min(1)
            .max(50)
            .default(10)
            .describe("Number of emails to send per batch (1 to 50, default 10)."),
          delaySecondsBetweenEmails: z
            .number()
            .int()
            .min(0)
            .max(300)
            .default(2)
            .describe(
              "Configurable delay in seconds between consecutive emails to respect Gmail rate limits.",
            ),
        })
        .strict(),
    },
    async (input) => {
      const campaign = await campaignService.createCampaign(input);
      return result(
        `Campaign "${campaign.name}" created in draft status (ID: ${campaign.id}, ${campaign.total_recipients} recipients). Preview or approve before sending.`,
        campaign,
      );
    },
  );

  server.registerTool(
    "preview_campaign",
    {
      title: "Preview outreach campaign",
      description:
        "Inspects a campaign before approval and sending: checks draft contents, recipient breakdown, suppression list matches, duplicate protection, Gmail connection, and active resume availability.",
      inputSchema: z
        .object({
          campaignId: z.number().int().positive().describe("Campaign ID to preview."),
        })
        .strict(),
    },
    async ({ campaignId }) => {
      const preview = await campaignService.previewCampaign({ campaignId });
      return result(
        `Campaign "${preview.name}" preview: ${preview.recipientsSummary.pending} pending recipients, approval status: ${preview.status}.`,
        preview,
      );
    },
  );

  server.registerTool(
    "approve_campaign",
    {
      title: "Approve outreach campaign",
      description:
        "Authorizes and locks one immutable campaign version and recipient list by calculating a cryptographic SHA-256 approval hash. Requires explicit confirmation (confirmApproval: true). Material modifications invalidate the approval and require re-approval.",
      inputSchema: z
        .object({
          campaignId: z.number().int().positive().describe("Campaign ID to approve."),
          confirmApproval: z
            .boolean()
            .default(false)
            .describe("Explicit confirmation to authorize and lock this immutable campaign version."),
        })
        .strict(),
    },
    async (input) => {
      const approval = await campaignService.approveCampaign(input);
      if (approval.requiresConfirmation) {
        return result("Campaign approval requires explicit confirmation.", approval);
      }
      return result(
        `Campaign ID ${approval.campaignId} approved and cryptographically locked (Version: ${approval.version}). Ready for send_campaign.`,
        approval,
      );
    },
  );

  server.registerTool(
    "send_campaign",
    {
      title: "Send approved campaign batch",
      description:
        "Dispatches a batch of emails for an approved campaign via Gmail. Enforces transactional campaign locking, duplicate send prevention, suppression list filtering, and configurable rate limits. Requires approved status and confirmSend: true.",
      inputSchema: z
        .object({
          campaignId: z.number().int().positive().describe("Approved campaign ID to send."),
          maxEmailsToSend: z
            .number()
            .int()
            .min(1)
            .max(50)
            .optional()
            .describe(
              "Optional maximum number of emails to dispatch in this batch (defaults to campaign batchSize).",
            ),
          confirmSend: z
            .boolean()
            .default(false)
            .describe("Explicit confirmation to dispatch the approved campaign batch."),
        })
        .strict(),
    },
    async (input) => {
      const sendResult = await campaignService.sendCampaign(input);
      if (sendResult.requiresConfirmation) {
        return result("Sending campaign batch requires explicit confirmation.", sendResult);
      }
      return result(sendResult.message, sendResult);
    },
  );

  server.registerTool(
    "pause_campaign",
    {
      title: "Pause outreach campaign",
      description: "Pauses an active or approved campaign, halting ongoing batch execution.",
      inputSchema: z
        .object({
          campaignId: z.number().int().positive().describe("Campaign ID to pause."),
        })
        .strict(),
    },
    async ({ campaignId }) => {
      const res = await campaignService.pauseCampaign({ campaignId });
      return result(`Campaign ${campaignId} paused. Call resume_campaign to continue.`, res);
    },
  );

  server.registerTool(
    "resume_campaign",
    {
      title: "Resume outreach campaign",
      description:
        "Resumes a paused campaign back to approved status after verifying the approval hash is still valid.",
      inputSchema: z
        .object({
          campaignId: z.number().int().positive().describe("Paused campaign ID to resume."),
        })
        .strict(),
    },
    async ({ campaignId }) => {
      const res = await campaignService.resumeCampaign({ campaignId });
      return result(`Campaign ${campaignId} resumed to approved status. Ready to send.`, res);
    },
  );

  server.registerTool(
    "stop_campaign",
    {
      title: "Stop outreach campaign",
      description:
        "Permanently terminates a campaign. Remaining pending recipients are marked skipped. Requires explicit confirmation (confirmStop: true).",
      inputSchema: z
        .object({
          campaignId: z.number().int().positive().describe("Campaign ID to stop permanently."),
          confirmStop: z
            .boolean()
            .default(false)
            .describe("Explicit confirmation required to stop the campaign permanently."),
        })
        .strict(),
    },
    async (input) => {
      const res = await campaignService.stopCampaign(input);
      if (res.requiresConfirmation) {
        return result("Stopping a campaign requires explicit confirmation.", res);
      }
      return result(`Campaign ${input.campaignId} stopped permanently.`, res);
    },
  );

  server.registerTool(
    "get_campaign_report",
    {
      title: "Get outreach campaign report",
      description:
        "Generates a comprehensive campaign progress report including delivery statistics, success rates, recipient statuses (sent, failed, skipped), and timestamps.",
      inputSchema: z
        .object({
          campaignId: z.number().int().positive().describe("Campaign ID to inspect."),
        })
        .strict(),
    },
    async ({ campaignId }) => {
      const report = await campaignService.getCampaignReport({ campaignId });
      const stats = report.statistics;
      return result(
        `Campaign "${report.campaign.name}" Report: ${stats.sent} sent, ${stats.failed} failed, ${stats.skipped} skipped, ${stats.pending} pending (${stats.successRatePercent}% success rate).`,
        report,
      );
    },
  );
}

