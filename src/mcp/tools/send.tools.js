import { z } from "zod";

function result(textContent, structuredContent) {
  return {
    content: [{ type: "text", text: textContent }],
    structuredContent,
  };
}

export function registerSendTools(server, emailSendingService) {
  server.registerTool(
    "send_test_email",
    {
      title: "Send single test email",
      description:
        "Sends a single controlled test email through the connected Gmail account. Requires explicit confirmation (confirmSend: true). Supports plain-text, HTML, active PDF resume attachment, and populating from saved email drafts. Never sends campaign emails.",
      inputSchema: z
        .object({
          recipientEmail: z
            .string()
            .trim()
            .email()
            .describe(
              "Recipient email address for the test email (e.g. your personal email address for testing).",
            ),
          recipientName: z
            .string()
            .trim()
            .max(200)
            .optional()
            .describe("Optional recipient display name."),
          subject: z
            .string()
            .trim()
            .min(1)
            .max(300)
            .optional()
            .describe("Subject line. Required unless draftId is provided."),
          bodyText: z
            .string()
            .trim()
            .min(1)
            .max(20_000)
            .optional()
            .describe("Plain-text body. Required unless draftId is provided."),
          bodyHtml: z
            .string()
            .trim()
            .max(50_000)
            .optional()
            .describe("Optional HTML formatted email body."),
          draftId: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Optional saved draft ID to populate subject and body from."),
          attachActiveResume: z
            .boolean()
            .default(false)
            .describe("Whether to attach the candidate's active PDF resume to the email."),
          confirmSend: z
            .boolean()
            .default(false)
            .describe("Explicit confirmation required to dispatch the email through Gmail."),
        })
        .strict(),
    },
    async (input) => {
      const sendResult = await emailSendingService.sendTestEmail(input);
      if (sendResult.requiresConfirmation) {
        return result("Test email requires explicit confirmation.", sendResult);
      }
      return result(
        `Test email successfully dispatched to ${sendResult.recipientEmail} (Gmail Message ID: ${sendResult.gmailMessageId}).`,
        sendResult,
      );
    },
  );
}

