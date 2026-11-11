import { z } from "zod";

const statusSchema = z.enum(["new", "contacted", "replied", "do_not_contact", "archived"]);
const text = z.string().trim().min(1).max(2_000);
const optionalText = z.string().trim().max(2_000).optional();
const paginationSchema = {
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).default(0),
};
const recruiterFieldsSchema = {
  name: text.max(500),
  email: text.max(254),
  company: z.string().trim().max(500).default(""),
  designation: z.string().trim().max(500).default(""),
  jobRole: z.string().trim().max(500).default(""),
  companyWebsite: z.string().trim().max(2_000).default(""),
  publicProfessionalInfo: z.string().trim().max(2_000).default(""),
  source: z.string().trim().max(500).default(""),
  lastContactedAt: z.iso.datetime().nullable().default(null),
  outreachStatus: statusSchema.default("new"),
};

function result(textContent, structuredContent) {
  return { content: [{ type: "text", text: textContent }], structuredContent };
}

export function registerRecruiterTools(server, recruiterService) {
  server.registerTool("create_recruiter", {
    title: "Create recruiter",
    description: "Adds one recruiter manually. Email addresses are deduplicated case-insensitively and are only format-checked, not deliverability-verified.",
    inputSchema: z.object(recruiterFieldsSchema).strict(),
  }, async (input) => result("Recruiter created.", await recruiterService.create(input)));

  server.registerTool("import_recruiters", {
    title: "Import recruiters from CSV",
    description: "Imports an explicit local CSV with name and email columns. Existing and within-file duplicate emails are skipped. Email checks are format-only, not deliverability verification.",
    inputSchema: z.object({
      sourcePath: text.max(4_096),
      defaultSource: z.string().trim().max(500).default(""),
      dryRun: z.boolean().default(false),
    }).strict(),
  }, async (input) => result("Recruiter CSV processed.", await recruiterService.importFromCsv(input)));

  server.registerTool("list_recruiters", {
    title: "List recruiters",
    description: "Lists recruiters with optional company, job-role, and outreach-status filters.",
    inputSchema: z.object({
      ...paginationSchema,
      company: optionalText,
      jobRole: optionalText,
      outreachStatus: statusSchema.optional(),
    }).strict(),
  }, async (input) => result("Recruiters retrieved.", recruiterService.list(input)));

  server.registerTool("search_recruiters", {
    title: "Search recruiters",
    description: "Searches recruiter names, emails, companies, designations, and target job roles.",
    inputSchema: z.object({ ...paginationSchema, query: text.max(500) }).strict(),
  }, async (input) => result("Recruiter search completed.", recruiterService.search(input)));

  server.registerTool("filter_recruiters", {
    title: "Filter recruiters",
    description: "Filters recruiters by company, target job role, or outreach status.",
    inputSchema: z.object({
      ...paginationSchema,
      company: optionalText,
      jobRole: optionalText,
      outreachStatus: statusSchema.optional(),
    }).strict().refine((input) => input.company || input.jobRole || input.outreachStatus, {
      message: "Provide at least one filter.",
    }),
  }, async (input) => result("Recruiter filter completed.", recruiterService.list(input)));

  server.registerTool("validate_contacts", {
    title: "Validate recruiter contact formats",
    description: "Checks email syntax for selected or all recruiters. This does not verify mailbox ownership, existence, or deliverability.",
    inputSchema: z.object({ recruiterIds: z.array(z.number().int().positive()).min(1).max(500).optional() }).strict(),
  }, async (input) => result("Contact format validation completed.", await recruiterService.validateContacts(input)));

  server.registerTool("update_recruiter", {
    title: "Update recruiter",
    description: "Updates a stored recruiter. Email addresses are deduplicated case-insensitively and are only format-checked.",
    inputSchema: z.object({
      id: z.number().int().positive(),
      name: optionalText,
      email: optionalText,
      company: optionalText,
      designation: optionalText,
      jobRole: optionalText,
      companyWebsite: optionalText,
      publicProfessionalInfo: optionalText,
      source: optionalText,
      lastContactedAt: z.iso.datetime().nullable().optional(),
      outreachStatus: statusSchema.optional(),
    }).strict().refine((input) => Object.keys(input).some((key) => key !== "id"), {
      message: "Provide at least one recruiter field to update.",
    }),
  }, async ({ id, ...updates }) => result("Recruiter updated.", await recruiterService.update(id, updates)));

  server.registerTool("delete_recruiter", {
    title: "Delete recruiter",
    description: "Permanently deletes one recruiter after explicit confirmation. This cannot be undone.",
    inputSchema: z.object({ id: z.number().int().positive(), confirmDelete: z.literal(true) }).strict(),
  }, async ({ id }) => result("Recruiter deleted.", await recruiterService.delete(id)));
}

