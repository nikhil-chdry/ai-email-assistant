import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabase } from "../database/connection.js";
import { ProfileService } from "../services/profile.service.js";
import { EmailDraftService } from "../services/email-draft.service.js";
import { RecruiterService } from "../services/recruiter.service.js";
import { GmailOAuthService } from "../services/gmail-oauth.service.js";
import { EmailSendingService } from "../services/email-sending.service.js";
import { CampaignService } from "../services/campaign.service.js";
import { ReplyTrackingService } from "../services/reply-tracking.service.js";
import { registerProfileTools } from "./tools/profile.tools.js";
import { registerEmailTools } from "./tools/email.tools.js";
import { registerRecruiterTools } from "./tools/recruiter.tools.js";
import { registerSystemTools } from "./tools/system.tools.js";
import { registerGmailTools } from "./tools/gmail.tools.js";
import { registerSendTools } from "./tools/send.tools.js";
import { registerCampaignTools } from "./tools/campaign.tools.js";
import { registerReplyTools } from "./tools/reply.tools.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export async function createMcpServer({
  databasePath,
  uploadsDirectory,
  gmailOAuthService: customGmailOAuthService,
  emailSendingService: customEmailSendingService,
  campaignService: customCampaignService,
  replyTrackingService: customReplyTrackingService,
  clientId,
  clientSecret,
  redirectUri,
  encryptionKey,
  fetchFn,
  delayMultiplier,
} = {}) {
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
  const gmailOAuthService =
    customGmailOAuthService ??
    new GmailOAuthService({
      database,
      clientId,
      clientSecret,
      redirectUri,
      encryptionKey,
      fetchFn,
    });
  const emailSendingService =
    customEmailSendingService ??
    new EmailSendingService({
      database,
      profileService,
      gmailOAuthService,
      fetchFn,
    });
  const campaignService =
    customCampaignService ??
    new CampaignService({
      database,
      profileService,
      gmailOAuthService,
      fetchFn,
      delayMultiplier,
    });
  const replyTrackingService =
    customReplyTrackingService ??
    new ReplyTrackingService({
      database,
      profileService,
      gmailOAuthService,
      fetchFn,
    });

  const server = new McpServer({
    name: "ai-email-assistant",
    version: "1.0.0",
  });

  registerSystemTools(server);
  registerProfileTools(server, profileService);
  registerRecruiterTools(server, recruiterService);
  registerEmailTools(server, emailDraftService);
  registerGmailTools(server, gmailOAuthService);
  registerSendTools(server, emailSendingService);
  registerCampaignTools(server, campaignService);
  registerReplyTools(server, replyTrackingService);

  server.closeDatabase = async () => {
    await gmailOAuthService.close();
    await database.close();
  };
  server.database = database;
  server.profileService = profileService;
  server.recruiterService = recruiterService;
  server.emailDraftService = emailDraftService;
  server.gmailOAuthService = gmailOAuthService;
  server.emailSendingService = emailSendingService;
  server.campaignService = campaignService;
  server.replyTrackingService = replyTrackingService;

  return server;
}
