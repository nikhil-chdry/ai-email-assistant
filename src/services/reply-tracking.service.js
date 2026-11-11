import { logError, logInfo } from "../utils/logger.js";

const GMAIL_THREADS_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/threads";

export const CLASSIFICATIONS = [
  "positive_response",
  "rejection",
  "interview_invitation",
  "other",
];

export class ReplyTrackingService {
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
   * Checks Gmail for incoming replies across active outreach threads.
   * Cancels scheduled follow-ups automatically upon discovering a reply.
   */
  async checkReplies() {
    const status = await this.gmailOAuthService.getStatus();
    if (!status.connected) {
      throw new Error("Gmail is not connected. Use connect_gmail to authorize before checking replies.");
    }

    const myEmail = status.email.toLowerCase().trim();
    const accessToken = await this.gmailOAuthService.getValidAccessToken();

    // Find all outreach emails with a valid gmail_thread_id
    const sentThreads = this.database.all(
      `SELECT DISTINCT gmail_thread_id, recruiter_id, recipient_email, subject, sent_at
       FROM sent_emails
       WHERE gmail_thread_id IS NOT NULL AND status = 'sent'
       ORDER BY sent_at DESC`,
    );

    if (sentThreads.length === 0) {
      return {
        checkedThreads: 0,
        newRepliesFound: 0,
        replies: [],
        message: "No sent outreach threads found to monitor.",
      };
    }

    const newReplies = [];

    for (const threadInfo of sentThreads) {
      const threadId = threadInfo.gmail_thread_id;
      let threadData;

      try {
        const response = await this.fetchFn(
          `${GMAIL_THREADS_ENDPOINT}/${threadId}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
          {
            headers: { Authorization: `Bearer ${accessToken}` },
          },
        );

        if (!response.ok) {
          logError("Failed to fetch thread from Gmail API", { threadId, status: response.status });
          continue;
        }

        threadData = await response.json();
      } catch (err) {
        logError("Network error fetching Gmail thread", { threadId, error: err.message });
        continue;
      }

      const messages = threadData.messages || [];
      for (const msg of messages) {
        const headers = msg.payload?.headers || [];
        const fromHeader = headers.find((h) => h.name.toLowerCase() === "from")?.value || "";
        const subjectHeader = headers.find((h) => h.name.toLowerCase() === "subject")?.value || threadInfo.subject;
        const dateHeader = headers.find((h) => h.name.toLowerCase() === "date")?.value;

        // Skip messages sent by the candidate
        if (fromHeader.toLowerCase().includes(myEmail)) {
          continue;
        }

        // Check if message already recorded
        const existing = this.database.get(
          "SELECT id FROM recruiter_replies WHERE gmail_message_id = ?",
          [msg.id],
        );
        if (existing) continue;

        const receivedAt = dateHeader
          ? new Date(dateHeader).toISOString()
          : msg.internalDate
            ? new Date(parseInt(msg.internalDate, 10)).toISOString()
            : new Date().toISOString();

        const now = new Date().toISOString();
        const replyRecord = await this.database.transaction((db) => {
          const insertRow = db.run(
            `INSERT INTO recruiter_replies (
              recruiter_id, recipient_email, gmail_message_id, gmail_thread_id,
              subject, snippet, from_header, classification, received_at,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'unclassified', ?, ?, ?)`,
            [
              threadInfo.recruiter_id,
              threadInfo.recipient_email,
              msg.id,
              threadId,
              subjectHeader,
              msg.snippet || "",
              fromHeader,
              receivedAt,
              now,
              now,
            ],
          );

          // Update recruiter status to 'replied'
          db.run(
            "UPDATE recruiters SET outreach_status = 'replied', updated_at = ? WHERE id = ?",
            [now, threadInfo.recruiter_id],
          );

          // AUTOMATIC CANCELLATION: cancel any pending follow-ups for this recruiter
          db.run(
            `UPDATE scheduled_followups
             SET status = 'cancelled', cancel_reason = 'reply_received', updated_at = ?
             WHERE recruiter_id = ? AND status = 'pending'`,
            [now, threadInfo.recruiter_id],
          );

          db.run(
            `INSERT INTO activity_logs (action, details_json, created_at) VALUES (?, ?, ?)`,
            [
              "reply_detected",
              JSON.stringify({
                recruiterId: threadInfo.recruiter_id,
                email: threadInfo.recipient_email,
                gmailMessageId: msg.id,
              }),
              now,
            ],
          );

          return db.get("SELECT * FROM recruiter_replies WHERE id = ?", [insertRow.lastInsertRowid]);
        });

        newReplies.push({
          id: replyRecord.id,
          recruiterId: replyRecord.recruiter_id,
          recipientEmail: replyRecord.recipient_email,
          subject: replyRecord.subject,
          snippet: replyRecord.snippet,
          fromHeader: replyRecord.from_header,
          receivedAt: replyRecord.received_at,
          classification: replyRecord.classification,
          actionRequired:
            "Classify this reply as: positive_response, rejection, interview_invitation, or other. Never auto-reply to interview invitations or compensation inquiries.",
        });
      }
    }

    logInfo("Completed check_replies", {
      checkedThreads: sentThreads.length,
      newRepliesFound: newReplies.length,
    });

    return {
      checkedThreads: sentThreads.length,
      newRepliesFound: newReplies.length,
      replies: newReplies,
      message: `Checked ${sentThreads.length} outreach threads. Discovered ${newReplies.length} new replies. Any pending follow-ups for replied recruiters have been cancelled automatically.`,
    };
  }

  /**
   * Classifies an existing recruiter reply.
   */
  async classifyReply({ replyId, classification, reason = "" }) {
    if (!CLASSIFICATIONS.includes(classification)) {
      throw new Error(`Invalid classification. Allowed: ${CLASSIFICATIONS.join(", ")}`);
    }

    const reply = this.database.get("SELECT * FROM recruiter_replies WHERE id = ?", [replyId]);
    if (!reply) throw new Error(`Reply with ID ${replyId} not found.`);

    const now = new Date().toISOString();
    await this.database.transaction((db) => {
      db.run(
        `UPDATE recruiter_replies SET classification = ?, classification_reason = ?, updated_at = ? WHERE id = ?`,
        [classification, reason.trim(), now, replyId],
      );

      db.run(
        `INSERT INTO activity_logs (action, details_json, created_at) VALUES (?, ?, ?)`,
        [
          "reply_classified",
          JSON.stringify({ replyId, classification, recruiterId: reply.recruiter_id }),
          now,
        ],
      );
    });

    return {
      replyId,
      classification,
      reason: reason.trim(),
      message: `Reply ${replyId} classified as '${classification}'.`,
    };
  }

  /**
   * Schedules follow-up reminders for contacted recruiters who haven't replied.
   */
  async scheduleFollowups({ recruiterIds, daysDelay = 4, campaignId } = {}) {
    if (daysDelay < 1 || daysDelay > 30) {
      throw new Error("daysDelay must be between 1 and 30 days.");
    }

    let candidates = [];
    if (Array.isArray(recruiterIds) && recruiterIds.length > 0) {
      const placeholders = recruiterIds.map(() => "?").join(",");
      candidates = this.database.all(
        `SELECT DISTINCT s.id AS sent_email_id, s.recruiter_id, s.recipient_email, s.gmail_thread_id, s.sent_at, s.campaign_id, r.outreach_status
         FROM sent_emails s
         JOIN recruiters r ON r.id = s.recruiter_id
         WHERE s.status = 'sent' AND s.recruiter_id IN (${placeholders})`,
        recruiterIds,
      );
    } else {
      candidates = this.database.all(
        `SELECT DISTINCT s.id AS sent_email_id, s.recruiter_id, s.recipient_email, s.gmail_thread_id, s.sent_at, s.campaign_id, r.outreach_status
         FROM sent_emails s
         JOIN recruiters r ON r.id = s.recruiter_id
         WHERE s.status = 'sent' AND r.outreach_status = 'contacted'`,
      );
    }

    const scheduled = [];
    const now = new Date();

    await this.database.transaction((db) => {
      for (const item of candidates) {
        // Skip if already replied
        if (item.outreach_status === "replied") continue;
        const hasReply = db.get(
          "SELECT id FROM recruiter_replies WHERE recruiter_id = ?",
          [item.recruiter_id],
        );
        if (hasReply) continue;

        // Skip if already has pending follow-up
        const existingFollowup = db.get(
          "SELECT id FROM scheduled_followups WHERE recruiter_id = ? AND status = 'pending'",
          [item.recruiter_id],
        );
        if (existingFollowup) continue;

        const sentDate = new Date(item.sent_at);
        const scheduledTime = new Date(sentDate.getTime() + daysDelay * 24 * 60 * 60 * 1000).toISOString();

        const inserted = db.run(
          `INSERT INTO scheduled_followups (
            recruiter_id, campaign_id, original_sent_email_id, gmail_thread_id,
            sequence_number, scheduled_at, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 1, ?, 'pending', ?, ?)`,
          [
            item.recruiter_id,
            campaignId ?? item.campaign_id ?? null,
            item.sent_email_id,
            item.gmail_thread_id || "",
            scheduledTime,
            now.toISOString(),
            now.toISOString(),
          ],
        );

        scheduled.push({
          id: inserted.lastInsertRowid,
          recruiterId: item.recruiter_id,
          recipientEmail: item.recipient_email,
          scheduledAt: scheduledTime,
          status: "pending",
        });
      }
    });

    return {
      scheduledCount: scheduled.length,
      scheduled,
      processLimitationNote:
        "Limitation: Follow-up schedules operate locally and execute only while this MCP server process is running. No background cloud workers are used.",
    };
  }

  /**
   * Retrieves pending follow-ups.
   */
  getPendingFollowups({ dueOnly = false, campaignId } = {}) {
    const now = new Date().toISOString();
    let query = `
      SELECT f.id, f.recruiter_id, f.campaign_id, f.gmail_thread_id, f.sequence_number,
             f.scheduled_at, f.status, r.name AS recruiter_name, r.email AS recruiter_email,
             r.company, r.job_role, s.subject AS original_subject, s.sent_at AS original_sent_at
      FROM scheduled_followups f
      JOIN recruiters r ON r.id = f.recruiter_id
      JOIN sent_emails s ON s.id = f.original_sent_email_id
      WHERE f.status = 'pending'
    `;
    const params = [];

    if (dueOnly) {
      query += " AND f.scheduled_at <= ?";
      params.push(now);
    }
    if (campaignId) {
      query += " AND f.campaign_id = ?";
      params.push(campaignId);
    }

    query += " ORDER BY f.scheduled_at ASC";

    const followups = this.database.all(query, params).map((f) => ({
      id: f.id,
      recruiterId: f.recruiter_id,
      recruiterName: f.recruiter_name,
      recruiterEmail: f.recruiter_email,
      company: f.company,
      jobRole: f.job_role,
      originalSubject: f.original_subject,
      originalSentAt: f.original_sent_at,
      scheduledAt: f.scheduled_at,
      isDueNow: f.scheduled_at <= now,
    }));

    return {
      totalPending: followups.length,
      dueCount: followups.filter((f) => f.isDueNow).length,
      followups,
      processLimitationNote:
        "Limitation: Follow-up schedules operate locally and run only while this MCP server process is running.",
    };
  }

  /**
   * Generates a truthful follow-up writing brief for Claude / Antigravity.
   * Does NOT auto-send email. Never auto-replies to interview invitations.
   */
  async generateFollowup({ recruiterId, followupId, tone = "polite" }) {
    let followup = null;
    let targetRecruiterId = recruiterId;

    if (followupId) {
      followup = this.database.get("SELECT * FROM scheduled_followups WHERE id = ?", [followupId]);
      if (!followup) throw new Error(`Follow-up with ID ${followupId} not found.`);
      targetRecruiterId = followup.recruiter_id;
    }

    const recruiter = this.database.get("SELECT * FROM recruiters WHERE id = ?", [targetRecruiterId]);
    if (!recruiter) throw new Error(`Recruiter with ID ${targetRecruiterId} not found.`);

    // Check if recruiter has already replied
    const replies = this.database.all(
      "SELECT * FROM recruiter_replies WHERE recruiter_id = ? ORDER BY received_at DESC",
      [targetRecruiterId],
    );

    if (replies.length > 0) {
      const interviewInvite = replies.find((r) => r.classification === "interview_invitation");
      if (interviewInvite) {
        throw new Error(
          `Cannot auto-generate generic follow-up: Recruiter ${recruiter.name} sent an interview invitation. Review and respond personally!`,
        );
      }
      throw new Error(
        `Recruiter ${recruiter.name} has already replied (Snippet: "${replies[0].snippet}"). Standard follow-up is not allowed after receiving a reply.`,
      );
    }

    const lastOutreach = this.database.get(
      "SELECT * FROM sent_emails WHERE recruiter_id = ? AND status = 'sent' ORDER BY sent_at DESC LIMIT 1",
      [targetRecruiterId],
    );

    const profile = this.profileService.getProfile();
    const resumeInfo = this.profileService.getResumeInformation();

    // Mark follow-up as draft_generated if linked to scheduled follow-up
    if (followup) {
      const now = new Date().toISOString();
      await this.database.transaction((db) => {
        db.run(
          "UPDATE scheduled_followups SET status = 'draft_generated', updated_at = ? WHERE id = ?",
          [now, followup.id],
        );
      });
    }

    return {
      mode: "client-side AI follow-up draft brief",
      disclaimer:
        "Draft-only workflow: AI assistant must compose the follow-up draft. Follow-ups are never sent automatically.",
      recruiter: {
        id: recruiter.id,
        name: recruiter.name,
        company: recruiter.company,
        jobRole: recruiter.job_role,
        email: recruiter.email,
      },
      originalOutreach: {
        subject: lastOutreach?.subject || "Previous outreach",
        sentAt: lastOutreach?.sent_at || "Recent outreach",
      },
      candidate: {
        fullName: profile.fullName,
        college: profile.college,
        degree: profile.degree,
        graduationBatch: profile.graduationBatch,
        careerPreference: profile.careerPreference,
        topSkills: (profile.technicalSkills || []).slice(0, 6),
        keyProjects: (profile.projects || []).slice(0, 3),
      },
      constraints: [
        "Length: 50 to 80 words maximum (brief, respectful, gentle bump).",
        "Reference the previous message politely without guilt-tripping or presumption.",
        "Highlight 1-2 core skills relevant to the role.",
        "Reiterate interest and ask if they have a few minutes for a brief chat or if another team member is the right contact.",
        "Do NOT invent unverified claims or call paid AI APIs.",
        "Present the composed draft to the user for review before any sending.",
      ],
      suggestedSubject: lastOutreach?.subject
        ? `Re: ${lastOutreach.subject.replace(/^Re:\s*/i, "")}`
        : `Following up — ${profile.fullName} (${recruiter.jobRole || "Engineering"})`,
    };
  }
}
