import crypto from "node:crypto";
import { buildMimeMessage, encodeRawForGmail } from "../utils/mime-builder.js";
import { logError, logInfo } from "../utils/logger.js";

const GMAIL_SEND_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

export class CampaignService {
  /**
   * @param {object} options
   * @param {import('../database/connection.js').LocalDatabase} options.database
   * @param {import('./profile.service.js').ProfileService} options.profileService
   * @param {import('./gmail-oauth.service.js').GmailOAuthService} options.gmailOAuthService
   * @param {typeof fetch} [options.fetchFn]
   * @param {number} [options.delayMultiplier=1] Optional multiplier for test speedup
   */
  constructor({
    database,
    profileService,
    gmailOAuthService,
    fetchFn = globalThis.fetch,
    delayMultiplier = 1,
  }) {
    this.database = database;
    this.profileService = profileService;
    this.gmailOAuthService = gmailOAuthService;
    this.fetchFn = fetchFn;
    this.delayMultiplier = delayMultiplier;
  }

  /**
   * Creates a new campaign in 'draft' status.
   */
  async createCampaign({
    name,
    description = "",
    emailDraftId,
    recruiterIds,
    attachActiveResume = false,
    batchSize = 10,
    delaySecondsBetweenEmails = 2,
  }) {
    if (!name || typeof name !== "string" || name.trim().length === 0) {
      throw new Error("Campaign name is required.");
    }
    if (!emailDraftId) {
      throw new Error("emailDraftId is required to associate an email template.");
    }

    const draft = this.database.get("SELECT * FROM email_drafts WHERE id = ?", [emailDraftId]);
    if (!draft) {
      throw new Error(`Email draft with ID ${emailDraftId} does not exist.`);
    }

    // Resolve recruiters
    let recruiters = [];
    if (Array.isArray(recruiterIds) && recruiterIds.length > 0) {
      const placeholders = recruiterIds.map(() => "?").join(",");
      recruiters = this.database.all(
        `SELECT * FROM recruiters WHERE id IN (${placeholders})`,
        recruiterIds,
      );
    } else {
      recruiters = this.database.all(
        "SELECT * FROM recruiters WHERE outreach_status = 'new' AND email_format_valid = 1",
      );
    }

    if (recruiters.length === 0) {
      throw new Error("No eligible recruiters found for this campaign.");
    }

    // Deduplicate recruiters by lowercase email and filter do_not_contact
    const seenEmails = new Set();
    const eligibleRecruiters = [];
    for (const r of recruiters) {
      const normalized = r.email.toLowerCase().trim();
      if (seenEmails.has(normalized)) continue;
      if (r.outreach_status === "do_not_contact") continue;
      seenEmails.add(normalized);
      eligibleRecruiters.push(r);
    }

    if (eligibleRecruiters.length === 0) {
      throw new Error("All selected recruiters were duplicates or marked do_not_contact.");
    }

    const now = new Date().toISOString();
    const campaignId = await this.database.transaction((db) => {
      const row = db.run(
        `INSERT INTO campaigns (
          name, description, email_draft_id, attach_active_resume,
          batch_size, delay_seconds_between_emails, status, version,
          total_recipients, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'draft', 1, ?, ?, ?)`,
        [
          name.trim(),
          description.trim(),
          emailDraftId,
          attachActiveResume ? 1 : 0,
          Math.max(1, Math.min(50, batchSize)),
          Math.max(0, Math.min(300, delaySecondsBetweenEmails)),
          eligibleRecruiters.length,
          now,
          now,
        ],
      );

      const id = row.lastInsertRowid;
      for (const r of eligibleRecruiters) {
        db.run(
          `INSERT INTO campaign_recipients (
            campaign_id, recruiter_id, email, name, company, job_role,
            status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
          [
            id,
            r.id,
            r.email.trim(),
            r.name.trim(),
            r.company.trim(),
            r.job_role.trim(),
            now,
            now,
          ],
        );
      }

      db.run(
        `INSERT INTO activity_logs (action, details_json, created_at) VALUES (?, ?, ?)`,
        [
          "campaign_created",
          JSON.stringify({ campaignId: id, name: name.trim(), totalRecipients: eligibleRecruiters.length }),
          now,
        ],
      );

      return id;
    });

    return this.getCampaign(campaignId);
  }

  /**
   * Computes an immutable SHA-256 cryptographic hash over the campaign draft and recipient list.
   */
  computeApprovalHash(campaignId) {
    const campaign = this.database.get("SELECT * FROM campaigns WHERE id = ?", [campaignId]);
    if (!campaign) throw new Error(`Campaign ${campaignId} not found.`);

    const draft = this.database.get("SELECT * FROM email_drafts WHERE id = ?", [campaign.email_draft_id]);
    if (!draft) throw new Error(`Draft ${campaign.email_draft_id} not found.`);

    const recipients = this.database.all(
      "SELECT email FROM campaign_recipients WHERE campaign_id = ? ORDER BY email ASC",
      [campaignId],
    );

    const payload = [
      campaign.id,
      campaign.version,
      campaign.attach_active_resume,
      draft.id,
      draft.subject,
      draft.body_text,
      recipients.map((r) => r.email.toLowerCase().trim()).join(","),
    ].join("::");

    return crypto.createHash("sha256").update(payload, "utf8").digest("hex");
  }

  /**
   * Returns a detailed preview of the campaign before approval and sending.
   */
  async previewCampaign({ campaignId }) {
    const campaign = this.getCampaign(campaignId);
    if (!campaign) throw new Error(`Campaign ${campaignId} not found.`);

    const draft = this.database.get("SELECT * FROM email_drafts WHERE id = ?", [campaign.email_draft_id]);
    const recipients = this.database.all(
      "SELECT * FROM campaign_recipients WHERE campaign_id = ?",
      [campaignId],
    );

    const suppressionRows = this.database.all("SELECT email FROM suppression_list");
    const suppressedSet = new Set(suppressionRows.map((r) => r.email.toLowerCase().trim()));

    let suppressedCount = 0;
    let pendingCount = 0;
    for (const r of recipients) {
      if (suppressedSet.has(r.email.toLowerCase().trim())) {
        suppressedCount++;
      }
      if (r.status === "pending") {
        pendingCount++;
      }
    }

    const gmailStatus = await this.gmailOAuthService.getStatus();
    const resumeInfo = campaign.attach_active_resume ? this.profileService.getResumeInformation() : null;

    const currentHash = this.computeApprovalHash(campaignId);
    const isApprovalValid = campaign.status === "approved" && campaign.approval_hash === currentHash;

    return {
      campaignId: campaign.id,
      name: campaign.name,
      description: campaign.description,
      status: campaign.status,
      version: campaign.version,
      isApprovalValid,
      approvalHash: campaign.approval_hash,
      approvedAt: campaign.approved_at,
      draft: {
        id: draft?.id,
        template: draft?.template,
        subject: draft?.subject,
        bodyPreview: draft?.body_text ? `${draft.body_text.slice(0, 160)}...` : "",
      },
      recipientsSummary: {
        total: recipients.length,
        pending: pendingCount,
        sent: campaign.sent_count,
        failed: campaign.failed_count,
        skipped: campaign.skipped_count,
        currentlySuppressed: suppressedCount,
      },
      checks: {
        gmailConnected: gmailStatus.connected,
        senderEmail: gmailStatus.connected ? gmailStatus.email : null,
        activeResumeAttached: Boolean(campaign.attach_active_resume),
        hasResume: resumeInfo?.hasResume ?? false,
      },
      settings: {
        batchSize: campaign.batch_size,
        delaySeconds: campaign.delay_seconds_between_emails,
      },
    };
  }

  /**
   * Approves a campaign, locking in the cryptographic approval hash.
   */
  async approveCampaign({ campaignId, confirmApproval = false }) {
    if (!confirmApproval) {
      const preview = await this.previewCampaign({ campaignId });
      return {
        approved: false,
        requiresConfirmation: true,
        message: "Campaign approval requires explicit confirmation. Set confirmApproval: true to authorize.",
        preview,
      };
    }

    const campaign = this.getCampaign(campaignId);
    if (!campaign) throw new Error(`Campaign ${campaignId} not found.`);

    if (campaign.total_recipients === 0) {
      throw new Error("Cannot approve a campaign with zero recipients.");
    }

    const gmailStatus = await this.gmailOAuthService.getStatus();
    if (!gmailStatus.connected) {
      throw new Error("Cannot approve campaign: Gmail account is not connected.");
    }

    if (campaign.attach_active_resume) {
      const resume = await this.profileService.getActiveResumeFile();
      if (!resume) {
        throw new Error("Cannot approve campaign: Active resume is required but not uploaded.");
      }
    }

    const hash = this.computeApprovalHash(campaignId);
    const now = new Date().toISOString();

    await this.database.transaction((db) => {
      db.run(
        `UPDATE campaigns SET
          status = 'approved',
          approval_hash = ?,
          approved_at = ?,
          approved_by = 'user',
          updated_at = ?
        WHERE id = ?`,
        [hash, now, now, campaignId],
      );

      db.run(
        `INSERT INTO activity_logs (action, details_json, created_at) VALUES (?, ?, ?)`,
        [
          "campaign_approved",
          JSON.stringify({ campaignId, hash, version: campaign.version }),
          now,
        ],
      );
    });

    return {
      approved: true,
      campaignId,
      status: "approved",
      version: campaign.version,
      approvalHash: hash,
      approvedAt: now,
      message: `Campaign "${campaign.name}" approved and locked with version ${campaign.version}. Ready to send.`,
    };
  }

  /**
   * Dispatches a batch of emails for an approved campaign.
   */
  async sendCampaign({ campaignId, maxEmailsToSend, confirmSend = false }) {
    const campaign = this.getCampaign(campaignId);
    if (!campaign) throw new Error(`Campaign ${campaignId} not found.`);

    if (!confirmSend) {
      const preview = await this.previewCampaign({ campaignId });
      return {
        confirmed: false,
        requiresConfirmation: true,
        message: "Sending an approved campaign requires explicit confirmation. Set confirmSend: true to dispatch.",
        preview,
      };
    }

    // Verify approval hash
    const currentHash = this.computeApprovalHash(campaignId);
    if (campaign.status !== "approved" && campaign.status !== "sending" && campaign.status !== "paused") {
      throw new Error(`Cannot send campaign in '${campaign.status}' status. Campaign must be 'approved'.`);
    }
    if (campaign.approval_hash !== currentHash) {
      throw new Error("Campaign approval is invalid: content or recipients were modified after approval. Re-approval required.");
    }

    const gmailStatus = await this.gmailOAuthService.getStatus();
    if (!gmailStatus.connected) {
      throw new Error("Gmail is not connected. Use connect_gmail to authorize before sending.");
    }

    const fromEmail = gmailStatus.email;
    const profile = this.profileService.getProfile();
    const fromName = profile?.fullName || "Candidate";

    let attachment = null;
    let attachmentFilename = null;
    let attachmentSizeBytes = null;
    if (campaign.attach_active_resume) {
      const resume = await this.profileService.getActiveResumeFile();
      if (!resume) {
        throw new Error("Active resume attachment is enabled but file could not be loaded.");
      }
      attachment = {
        filename: resume.originalFilename,
        content: resume.buffer,
        mimeType: resume.mimeType,
      };
      attachmentFilename = resume.originalFilename;
      attachmentSizeBytes = resume.sizeBytes;
    }

    const draft = this.database.get("SELECT * FROM email_drafts WHERE id = ?", [campaign.email_draft_id]);
    if (!draft) throw new Error("Associated email draft could not be found.");

    // Transactional locking: transition status to 'sending'
    const now = new Date().toISOString();
    await this.database.transaction((db) => {
      db.run(
        `UPDATE campaigns SET status = 'sending', started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?`,
        [now, now, campaignId],
      );
    });

    const limit = Math.min(
      maxEmailsToSend || campaign.batch_size,
      campaign.batch_size,
    );

    const pendingRecipients = this.database.all(
      "SELECT * FROM campaign_recipients WHERE campaign_id = ? AND status = 'pending' ORDER BY id ASC LIMIT ?",
      [campaignId, limit],
    );

    if (pendingRecipients.length === 0) {
      await this.database.transaction((db) => {
        db.run(
          "UPDATE campaigns SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?",
          [now, now, campaignId],
        );
      });
      return {
        completed: true,
        campaignId,
        status: "completed",
        message: "No pending recipients remaining. Campaign marked completed.",
      };
    }

    const suppressionRows = this.database.all("SELECT email FROM suppression_list");
    const suppressedSet = new Set(suppressionRows.map((r) => r.email.toLowerCase().trim()));

    let sentInBatch = 0;
    let failedInBatch = 0;
    let skippedInBatch = 0;

    for (const recipient of pendingRecipients) {
      // Check live status in case pause/stop was triggered
      const liveCampaign = this.database.get("SELECT status FROM campaigns WHERE id = ?", [campaignId]);
      if (liveCampaign.status === "paused" || liveCampaign.status === "stopped") {
        logInfo(`Campaign send loop halted: status is ${liveCampaign.status}`);
        break;
      }

      const emailNormalized = recipient.email.toLowerCase().trim();

      // Suppression check
      if (suppressedSet.has(emailNormalized)) {
        await this.database.transaction((db) => {
          db.run(
            `UPDATE campaign_recipients SET status = 'skipped', skip_reason = 'suppression_list', updated_at = ? WHERE id = ?`,
            [new Date().toISOString(), recipient.id],
          );
          db.run(
            `UPDATE campaigns SET skipped_count = skipped_count + 1, updated_at = ? WHERE id = ?`,
            [new Date().toISOString(), campaignId],
          );
        });
        skippedInBatch++;
        continue;
      }

      // Duplicate send check: check if already sent
      const alreadySent = this.database.get(
        "SELECT id FROM sent_emails WHERE campaign_id = ? AND recipient_email = ? AND status = 'sent'",
        [campaignId, recipient.email],
      );
      if (alreadySent) {
        await this.database.transaction((db) => {
          db.run(
            `UPDATE campaign_recipients SET status = 'skipped', skip_reason = 'duplicate_send', updated_at = ? WHERE id = ?`,
            [new Date().toISOString(), recipient.id],
          );
          db.run(
            `UPDATE campaigns SET skipped_count = skipped_count + 1, updated_at = ? WHERE id = ?`,
            [new Date().toISOString(), campaignId],
          );
        });
        skippedInBatch++;
        continue;
      }

      // Build personalized message
      const mimeString = buildMimeMessage({
        fromEmail,
        fromName,
        toEmail: recipient.email,
        toName: recipient.name,
        subject: draft.subject,
        bodyText: draft.body_text,
        attachment,
      });

      const raw = encodeRawForGmail(mimeString);
      const accessToken = await this.gmailOAuthService.getValidAccessToken();
      const sendTime = new Date().toISOString();

      try {
        const response = await this.fetchFn(GMAIL_SEND_ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ raw }),
        });

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Gmail API error HTTP ${response.status}: ${errText.slice(0, 150)}`);
        }

        const resJson = await response.json();
        const { id: gmailMessageId, threadId: gmailThreadId } = resJson;

        await this.database.transaction((db) => {
          db.run(
            `UPDATE campaign_recipients SET
              status = 'sent',
              gmail_message_id = ?,
              gmail_thread_id = ?,
              sent_at = ?,
              updated_at = ?
            WHERE id = ?`,
            [gmailMessageId, gmailThreadId, sendTime, sendTime, recipient.id],
          );

          db.run(
            `INSERT INTO sent_emails (
              recipient_email, recipient_name, recruiter_id, email_draft_id,
              campaign_id, subject, body_text, has_attachment, attachment_filename,
              attachment_size_bytes, gmail_message_id, gmail_thread_id,
              send_type, status, sent_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'campaign', 'sent', ?)`,
            [
              recipient.email,
              recipient.name,
              recipient.recruiter_id,
              campaign.email_draft_id,
              campaignId,
              draft.subject,
              draft.body_text,
              attachment ? 1 : 0,
              attachmentFilename,
              attachmentSizeBytes,
              gmailMessageId,
              gmailThreadId,
              sendTime,
            ],
          );

          db.run(
            `UPDATE recruiters SET outreach_status = 'contacted', last_contacted_at = ?, updated_at = ? WHERE id = ?`,
            [sendTime, sendTime, recipient.recruiter_id],
          );

          db.run(
            `UPDATE campaigns SET sent_count = sent_count + 1, updated_at = ? WHERE id = ?`,
            [sendTime, campaignId],
          );
        });

        sentInBatch++;
      } catch (err) {
        logError("Failed to send campaign email to recipient", { email: recipient.email, error: err.message });

        await this.database.transaction((db) => {
          db.run(
            `UPDATE campaign_recipients SET
              status = 'failed',
              error_message = ?,
              updated_at = ?
            WHERE id = ?`,
            [err.message, sendTime, recipient.id],
          );

          db.run(
            `INSERT INTO sent_emails (
              recipient_email, recipient_name, recruiter_id, email_draft_id,
              campaign_id, subject, body_text, has_attachment, attachment_filename,
              attachment_size_bytes, send_type, status, error_message, sent_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'campaign', 'failed', ?, ?)`,
            [
              recipient.email,
              recipient.name,
              recipient.recruiter_id,
              campaign.email_draft_id,
              campaignId,
              draft.subject,
              draft.body_text,
              attachment ? 1 : 0,
              attachmentFilename,
              attachmentSizeBytes,
              err.message,
              sendTime,
            ],
          );

          db.run(
            `UPDATE campaigns SET failed_count = failed_count + 1, updated_at = ? WHERE id = ?`,
            [sendTime, campaignId],
          );
        });

        failedInBatch++;
      }

      // Configurable rate limit delay between emails
      if (campaign.delay_seconds_between_emails > 0) {
        await new Promise((r) =>
          setTimeout(r, campaign.delay_seconds_between_emails * 1000 * this.delayMultiplier),
        );
      }
    }

    // Determine final status after batch
    const remainingRow = this.database.get(
      "SELECT COUNT(*) AS count FROM campaign_recipients WHERE campaign_id = ? AND status = 'pending'",
      [campaignId],
    );
    const remainingPending = remainingRow.count;

    const finalNow = new Date().toISOString();
    let finalStatus = "approved";

    const liveAfter = this.database.get("SELECT status FROM campaigns WHERE id = ?", [campaignId]);
    if (liveAfter.status === "paused" || liveAfter.status === "stopped") {
      finalStatus = liveAfter.status;
    } else if (remainingPending === 0) {
      finalStatus = "completed";
      await this.database.transaction((db) => {
        db.run(
          "UPDATE campaigns SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?",
          [finalNow, finalNow, campaignId],
        );
      });
    } else {
      await this.database.transaction((db) => {
        db.run("UPDATE campaigns SET status = 'approved', updated_at = ? WHERE id = ?", [finalNow, campaignId]);
      });
    }

    await this.database.transaction((db) => {
      db.run(
        `INSERT INTO activity_logs (action, details_json, created_at) VALUES (?, ?, ?)`,
        [
          "campaign_batch_sent",
          JSON.stringify({ campaignId, sentInBatch, failedInBatch, skippedInBatch, remainingPending }),
          finalNow,
        ],
      );
    });

    return {
      success: true,
      campaignId,
      status: finalStatus,
      batchSummary: {
        sentInBatch,
        failedInBatch,
        skippedInBatch,
        remainingPending,
      },
      message: `Batch processed: ${sentInBatch} sent, ${failedInBatch} failed, ${skippedInBatch} skipped. Remaining: ${remainingPending}.`,
    };
  }

  /**
   * Pauses an approved or sending campaign.
   */
  async pauseCampaign({ campaignId }) {
    const campaign = this.getCampaign(campaignId);
    if (!campaign) throw new Error(`Campaign ${campaignId} not found.`);

    if (campaign.status === "completed" || campaign.status === "stopped") {
      throw new Error(`Cannot pause a campaign that is already '${campaign.status}'.`);
    }

    const now = new Date().toISOString();
    await this.database.transaction((db) => {
      db.run("UPDATE campaigns SET status = 'paused', updated_at = ? WHERE id = ?", [now, campaignId]);
      db.run(
        `INSERT INTO activity_logs (action, details_json, created_at) VALUES (?, ?, ?)`,
        ["campaign_paused", JSON.stringify({ campaignId }), now],
      );
    });

    return { paused: true, campaignId, status: "paused" };
  }

  /**
   * Resumes a paused campaign back to approved status.
   */
  async resumeCampaign({ campaignId }) {
    const campaign = this.getCampaign(campaignId);
    if (!campaign) throw new Error(`Campaign ${campaignId} not found.`);

    if (campaign.status !== "paused") {
      throw new Error(`Cannot resume campaign: status is '${campaign.status}', expected 'paused'.`);
    }

    const currentHash = this.computeApprovalHash(campaignId);
    if (campaign.approval_hash !== currentHash) {
      throw new Error("Cannot resume campaign: approval hash mismatch. Please re-approve.");
    }

    const now = new Date().toISOString();
    await this.database.transaction((db) => {
      db.run("UPDATE campaigns SET status = 'approved', updated_at = ? WHERE id = ?", [now, campaignId]);
      db.run(
        `INSERT INTO activity_logs (action, details_json, created_at) VALUES (?, ?, ?)`,
        ["campaign_resumed", JSON.stringify({ campaignId }), now],
      );
    });

    return { resumed: true, campaignId, status: "approved" };
  }

  /**
   * Stops a campaign permanently.
   */
  async stopCampaign({ campaignId, confirmStop = false }) {
    if (!confirmStop) {
      return {
        stopped: false,
        requiresConfirmation: true,
        message: "Stopping a campaign permanently requires explicit confirmation. Set confirmStop: true.",
      };
    }

    const campaign = this.getCampaign(campaignId);
    if (!campaign) throw new Error(`Campaign ${campaignId} not found.`);

    const now = new Date().toISOString();
    await this.database.transaction((db) => {
      db.run(
        `UPDATE campaign_recipients SET status = 'skipped', skip_reason = 'campaign_stopped', updated_at = ?
         WHERE campaign_id = ? AND status = 'pending'`,
        [now, campaignId],
      );

      const skippedCount = db.get(
        "SELECT COUNT(*) AS count FROM campaign_recipients WHERE campaign_id = ? AND status = 'skipped'",
        [campaignId],
      ).count;

      db.run(
        `UPDATE campaigns SET status = 'stopped', completed_at = ?, skipped_count = ?, updated_at = ? WHERE id = ?`,
        [now, skippedCount, now, campaignId],
      );

      db.run(
        `INSERT INTO activity_logs (action, details_json, created_at) VALUES (?, ?, ?)`,
        ["campaign_stopped", JSON.stringify({ campaignId }), now],
      );
    });

    return { stopped: true, campaignId, status: "stopped", message: "Campaign stopped permanently." };
  }

  /**
   * Resets failed recipients back to 'pending' for a retry batch.
   */
  async retryFailedRecipients({ campaignId }) {
    const campaign = this.getCampaign(campaignId);
    if (!campaign) throw new Error(`Campaign ${campaignId} not found.`);

    const now = new Date().toISOString();
    const retriedCount = await this.database.transaction((db) => {
      const failed = db.all(
        "SELECT id FROM campaign_recipients WHERE campaign_id = ? AND status = 'failed'",
        [campaignId],
      );
      if (failed.length === 0) return 0;

      db.run(
        `UPDATE campaign_recipients SET status = 'pending', error_message = NULL, updated_at = ?
         WHERE campaign_id = ? AND status = 'failed'`,
        [now, campaignId],
      );

      db.run(
        `UPDATE campaigns SET failed_count = failed_count - ?, status = 'approved', updated_at = ? WHERE id = ?`,
        [failed.length, now, campaignId],
      );

      return failed.length;
    });

    return { campaignId, retriedCount, message: `Reset ${retriedCount} failed recipients to pending.` };
  }

  /**
   * Generates a comprehensive report for the campaign.
   */
  async getCampaignReport({ campaignId }) {
    const campaign = this.getCampaign(campaignId);
    if (!campaign) throw new Error(`Campaign ${campaignId} not found.`);

    const draft = this.database.get("SELECT * FROM email_drafts WHERE id = ?", [campaign.email_draft_id]);
    const recipients = this.database.all(
      `SELECT id, email, name, company, job_role, status, skip_reason,
              gmail_message_id, gmail_thread_id, error_message, sent_at
       FROM campaign_recipients WHERE campaign_id = ? ORDER BY id ASC`,
      [campaignId],
    );

    const pendingCount = recipients.filter((r) => r.status === "pending").length;
    const totalProcessed = campaign.sent_count + campaign.failed_count + campaign.skipped_count;
    const successRatePercent = totalProcessed > 0
      ? Math.round((campaign.sent_count / totalProcessed) * 100)
      : 0;

    return {
      campaign: {
        id: campaign.id,
        name: campaign.name,
        description: campaign.description,
        status: campaign.status,
        version: campaign.version,
        approvalHash: campaign.approval_hash,
        approvedAt: campaign.approved_at,
        startedAt: campaign.started_at,
        completedAt: campaign.completed_at,
        attachActiveResume: Boolean(campaign.attach_active_resume),
      },
      draft: {
        id: draft?.id,
        template: draft?.template,
        subject: draft?.subject,
      },
      statistics: {
        totalRecipients: campaign.total_recipients,
        sent: campaign.sent_count,
        failed: campaign.failed_count,
        skipped: campaign.skipped_count,
        pending: pendingCount,
        successRatePercent,
      },
      recipients,
    };
  }

  /**
   * Suppression list methods
   */
  async addToSuppressionList({ email, reason = "unsubscribed" }) {
    if (!email || typeof email !== "string") throw new Error("Email is required.");
    const normalized = email.toLowerCase().trim();
    const now = new Date().toISOString();

    await this.database.transaction((db) => {
      db.run(
        `INSERT OR REPLACE INTO suppression_list (email, reason, created_at) VALUES (?, ?, ?)`,
        [normalized, reason, now],
      );
    });

    return { suppressed: true, email: normalized, reason };
  }

  getSuppressionList() {
    return this.database.all("SELECT * FROM suppression_list ORDER BY created_at DESC");
  }

  isSuppressed(email) {
    if (!email || typeof email !== "string") return false;
    const normalized = email.toLowerCase().trim();
    const row = this.database.get("SELECT email FROM suppression_list WHERE email = ?", [normalized]);
    return Boolean(row);
  }

  getCampaign(id) {
    return this.database.get("SELECT * FROM campaigns WHERE id = ?", [id]);
  }
}

