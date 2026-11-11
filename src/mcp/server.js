import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabase } from "../database/connection.js";
import { ProfileService } from "../services/profile.service.js";
import { EmailDraftService } from "../services/email-draft.service.js";
import { RecruiterService } from "../services/recruiter.service.js";
import { registerProfileTools } from "./tools/profile.tools.js";
import { registerEmailTools } from "./tools/email.tools.js";
import { registerRecruiterTools } from "./tools/recruiter.tools.js";
import { registerSystemTools } from "./tools/system.tools.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export async function createMcpServer({ databasePath, uploadsDirectory } = {}) {
  const database = await createDatabase({
    databasePath: databasePath ?? path.join(projectRoot, "data", "ai-email-assistant.sqlite"),
  });
  const profileService = new ProfileService({
    database,
    uploadsDirectory: uploadsDirectory ?? path.join(projectRoot, "uploads"),
  });
  await profileService.ensureInitialProfile();
  const recruiterService = new RecruiterService({ database });
  const emailDraftService = new EmailDraftService({ database, profileService, recruiterService });

  const server = new McpServer({
    name: "ai-email-assistant",
    version: "1.0.0",
  });

  registerSystemTools(server);
  registerProfileTools(server, profileService);
  registerRecruiterTools(server, recruiterService);
  registerEmailTools(server, emailDraftService);
  server.closeDatabase = () => database.close();
  return server;
}

