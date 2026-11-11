import { z } from "zod";
import { emailTemplates } from "../../services/email-draft.service.js";

const templateSchema = z.enum(emailTemplates);
const text = z.string().trim().min(1);

function result(textContent, structuredContent) {
  return { content: [{ type: "text", text: textContent }], structuredContent };
}

export function registerEmailTools(server, emailDraftService) {
  server.registerTool("generate_email", {
    title: "Prepare personalized email generation",
    description: "Builds a truthful personalized writing brief for Claude Desktop or Antigravity. The connected AI must write the draft itself; this local backend never calls paid AI APIs or sends email.",
    inputSchema: z.object({
      recruiterId: z.number().int().positive(),
      template: templateSchema,
      companyInformation: z.string().trim().max(4_000).default(""),
    }).strict(),
  }, async (input) => result("Email generation brief prepared. Compose the draft in this AI client, then save it.", emailDraftService.generateBrief(input)));

  server.registerTool("save_email_draft", {
    title: "Save email draft",
    description: "Saves an AI-client-written outreach draft locally. Saving a draft never sends email.",
    inputSchema: z.object({
      recruiterId: z.number().int().positive(),
      template: templateSchema,
      subject: text.max(200),
      body: text.max(10_000),
      companyInformation: z.string().trim().max(4_000).default(""),
    }).strict(),
  }, async (input) => result("Email draft saved locally; no email was sent.", await emailDraftService.save(input)));

  server.registerTool("get_email_drafts", {
    title: "Get email drafts",
    description: "Lists local unsent email drafts, optionally for one recruiter.",
    inputSchema: z.object({
      recruiterId: z.number().int().positive().optional(),
      limit: z.number().int().min(1).max(100).default(50),
      offset: z.number().int().min(0).default(0),
    }).strict(),
  }, async (input) => result("Email drafts retrieved.", emailDraftService.list(input)));

  server.registerTool("update_email_draft", {
    title: "Update email draft",
    description: "Updates one local unsent email draft. It never sends email.",
    inputSchema: z.object({
      id: z.number().int().positive(),
      template: templateSchema.optional(),
      subject: z.string().trim().min(1).max(200).optional(),
      body: z.string().trim().min(1).max(10_000).optional(),
      companyInformation: z.string().trim().max(4_000).optional(),
    }).strict().refine((input) => Object.keys(input).some((key) => key !== "id"), {
      message: "Provide at least one draft field to update.",
    }),
  }, async ({ id, ...updates }) => result("Email draft updated locally; no email was sent.", await emailDraftService.update(id, updates)));

  server.registerTool("delete_email_draft", {
    title: "Delete email draft",
    description: "Permanently deletes one unsent email draft after explicit confirmation.",
    inputSchema: z.object({ id: z.number().int().positive(), confirmDelete: z.literal(true) }).strict(),
  }, async ({ id }) => result("Email draft deleted.", await emailDraftService.delete(id)));
}

