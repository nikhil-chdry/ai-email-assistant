import { z } from "zod";

const optionalText = z.string().trim().min(1).max(2_000).optional();
const profileUpdateSchema = z.object({
  fullName: optionalText,
  college: optionalText,
  degree: optionalText,
  graduationBatch: optionalText,
  careerPreference: optionalText,
  technicalSkills: z.array(z.string().trim().min(1).max(100)).min(1).max(100).optional(),
  projects: z.array(z.string().trim().min(1).max(300)).min(1).max(100).optional(),
  research: optionalText,
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: "Provide at least one profile field to update.",
});

function result(text, structuredContent) {
  return { content: [{ type: "text", text }], structuredContent };
}

export function registerProfileTools(server, profileService) {
  server.registerTool("get_my_profile", {
    title: "Get my profile",
    description: "Returns the local candidate profile. Initial fields are user-provided and remain unverified until a resume is uploaded.",
    inputSchema: z.object({}).strict(),
  }, async () => result("Candidate profile retrieved.", profileService.getProfile()));

  server.registerTool("update_my_profile", {
    title: "Update my profile",
    description: "Updates one or more editable candidate-profile fields. Only provide claims that are truthful and supported by the current resume where possible.",
    inputSchema: profileUpdateSchema,
  }, async (updates) => result("Candidate profile updated.", await profileService.updateProfile(updates)));

  server.registerTool("upload_resume", {
    title: "Upload resume",
    description: "Copies a user-selected local PDF resume into protected local storage, extracts its text, and makes it the profile's primary source of truth. Replacing an existing resume requires explicit confirmation.",
    inputSchema: z.object({
      sourcePath: z.string().trim().min(1).max(4_096),
      confirmReplace: z.boolean().default(false),
    }).strict(),
  }, async (input) => result("Resume uploaded and parsed.", await profileService.uploadResume(input)));

  server.registerTool("get_resume_information", {
    title: "Get resume information",
    description: "Returns metadata and extracted text for the active local resume. Resume file paths are never exposed.",
    inputSchema: z.object({}).strict(),
  }, async () => result("Resume information retrieved.", profileService.getResumeInformation()));
}

