import { buildMimeMessage, encodeRawForGmail } from "../utils/mime-builder.js";
import { logError, logInfo } from "../utils/logger.js";

const GMAIL_SEND_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

export class EmailSendingService {
  /**
   * @param {object} options
   * @param {import('../database/connection.js').LocalDatabase} options.database
   * @param {import('./profile.service.js').ProfileService} options.profileService
   * @param {import('./gmail-oauth.service.js').GmailOAuthService} options.gmailOAuthService
   * @param {typeof fetch} [options.fetchFn]
   */
  constructor({
    database,
    profileService,
    gmailOAuthService,
    fetchFn = globalThis.fetch,
  }) {
    this.database = database;
    this.profileService = profileService;
    this.gmailOAuthService = gmailOAuthService;
    this.fetchFn = fetchFn;
  }

  /**
   * Sends a single controlled test email via Gmail.
   * Requires explicit confirmation (confirmSend: true).
   *
   * @param {object} options
   * @param {string} options.recipientEmail
   * @param {string} [options.recipientName]
   * @param {string} [options.subject]
   * @param {string} [options.bodyText]
   * @param {string} [options.bodyHtml]
   * @param {number} [options.draftId]
   * @param {boolean} [options.attachActiveResume=false]
   * @param {boolean} [options.confirmSend=false]
   * @returns {Promise<object>}
   */
  async sendTestEmail({
    recipientEmail,
    recipientName,
    subject,
    bodyText,
    bodyHtml,
    draftId,
    attachActiveResume = false,
    confirmSend = false,
  }) {
    if (!recipientEmail || typeof recipientEmail !== "string") {
      throw new Error("Recipient email is required.");
    }

    let resolvedSubject = subject?.trim();
    let resolvedBodyText = bodyText?.trim();
    let recruiterId = null;

    if (draftId) {
      const draft = this.database.get(
        "SELECT * FROM email_drafts WHERE id = ?",
        [draftId],
      );
      if (!draft) {
        throw new Error(`Email draft with ID ${draftId} does not exist.`);
      }
      resolvedSubject = resolvedSubject || draft.subject;
      resolvedBodyText = resolvedBodyText || draft.body_text;
      recruiterId = draft.recruiter_id;
    }

    if (!confirmSend) {
      return {
        confirmed: false,
        requiresConfirmation: true,
        message:
          "Sending a test email requires explicit confirmation. Set confirmSend: true to send.",
        preview: {
          recipientEmail: recipientEmail.trim(),
          recipientName: recipientName?.trim() || null,
          subject: resolvedSubject || null,
          bodySnippet: resolvedBodyText ? `${resolvedBodyText.slice(0, 150)}...` : null,
          hasDraft: Boolean(draftId),
          attachActiveResume: Boolean(attachActiveResume),
        },
      };
    }

    if (!resolvedSubject) {
      throw new Error("Subject line is required (provide subject or draftId).");
    }
    if (!resolvedBodyText && !bodyHtml) {
      throw new Error("Email body is required (provide bodyText, bodyHtml, or draftId).");
    }

    // Check Gmail connection
    const status = await this.gmailOAuthService.getStatus();
    if (!status.connected) {
      throw new Error("Gmail is not connected. Connect Gmail first using connect_gmail.");
    }

    const fromEmail = status.email;
    const profile = this.profileService.getProfile();
    const fromName = profile?.fullName || "Candidate";

    let attachment = null;
    let attachmentFilename = null;
    let attachmentSizeBytes = null;

    if (attachActiveResume) {
      const resumeFile = await this.profileService.getActiveResumeFile();
      if (!resumeFile) {
        throw new Error("No active resume is available to attach. Upload a resume first using upload_resume.");
      }
      attachment = {
        filename: resumeFile.originalFilename,
        content: resumeFile.buffer,
        mimeType: resumeFile.mimeType,
      };
      attachmentFilename = resumeFile.originalFilename;
      attachmentSizeBytes = resumeFile.sizeBytes;
    }

    const mimeString = buildMimeMessage({
      fromEmail,
      fromName,
      toEmail: recipientEmail.trim(),
      toName: recipientName?.trim(),
      subject: resolvedSubject,
      bodyText: resolvedBodyText || "",
      bodyHtml: bodyHtml?.trim(),
      attachment,
    });

    const raw = encodeRawForGmail(mimeString);
    const accessToken = await this.gmailOAuthService.getValidAccessToken();

    const now = new Date().toISOString();
    let response;
    let responseJson;

    try {
      response = await this.fetchFn(GMAIL_SEND_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ raw }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        const safeError = extractSendError(errorText);
        logError("Gmail messages.send returned an error", { status: response.status });

        await this.database.transaction((db) => {
          db.run(
            `INSERT INTO sent_emails (
              recipient_email, recipient_name, recruiter_id, email_draft_id,
              subject, body_text, body_html, has_attachment, attachment_filename,
              attachment_size_bytes, gmail_message_id, gmail_thread_id,
              send_type, status, error_message, sent_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'test', 'failed', ?, ?)`,
            [
              recipientEmail.trim(),
              recipientName?.trim() || "",
              recruiterId,
              draftId || null,
              resolvedSubject,
              resolvedBodyText || "",
              bodyHtml?.trim() || null,
              attachment ? 1 : 0,
              attachmentFilename,
              attachmentSizeBytes,
              safeError,
              now,
            ],
          );

          db.run(
            `INSERT INTO activity_logs (action, details_json, created_at) VALUES (?, ?, ?)`,
            [
              "test_email_failed",
              JSON.stringify({ recipientEmail: recipientEmail.trim(), error: safeError }),
              now,
            ],
          );
        });

        throw new Error(`Gmail API send failed (HTTP ${response.status}): ${safeError}`);
      }

      responseJson = await response.json();
    } catch (err) {
      if (err.message.startsWith("Gmail API send failed")) {
        throw err;
      }
      logError("Failed to reach Gmail API endpoint", err);
      throw new Error(`Network failure during Gmail send: ${err.message}`);
    }

    const { id: gmailMessageId, threadId: gmailThreadId } = responseJson;

    await this.database.transaction((db) => {
      db.run(
        `INSERT INTO sent_emails (
          recipient_email, recipient_name, recruiter_id, email_draft_id,
          subject, body_text, body_html, has_attachment, attachment_filename,
          attachment_size_bytes, gmail_message_id, gmail_thread_id,
          send_type, status, error_message, sent_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'test', 'sent', NULL, ?)`,
        [
          recipientEmail.trim(),
          recipientName?.trim() || "",
          recruiterId,
          draftId || null,
          resolvedSubject,
          resolvedBodyText || "",
          bodyHtml?.trim() || null,
          attachment ? 1 : 0,
          attachmentFilename,
          attachmentSizeBytes,
          gmailMessageId,
          gmailThreadId,
          now,
        ],
      );

      db.run(
        `INSERT INTO activity_logs (action, details_json, created_at) VALUES (?, ?, ?)`,
        [
          "test_email_sent",
          JSON.stringify({
            recipientEmail: recipientEmail.trim(),
            gmailMessageId,
            hasAttachment: Boolean(attachment),
          }),
          now,
        ],
      );
    });

    logInfo("Test email sent successfully via Gmail API", {
      recipientEmail: recipientEmail.trim(),
      gmailMessageId,
    });

    return {
      success: true,
      sendType: "test",
      recipientEmail: recipientEmail.trim(),
      recipientName: recipientName?.trim() || null,
      subject: resolvedSubject,
      hasAttachment: Boolean(attachment),
      attachmentFilename,
      attachmentSizeBytes,
      gmailMessageId,
      gmailThreadId,
      sentAt: now,
      message: `Test email successfully sent to ${recipientEmail.trim()} via Gmail.`,
    };
  }
}

function extractSendError(rawText) {
  try {
    const parsed = JSON.parse(rawText);
    return parsed.error?.message || parsed.error_description || parsed.error || rawText;
  } catch {
    return rawText.slice(0, 200);
  }
}

