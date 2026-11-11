export const id = "007-replies-and-followups";

export function up(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS recruiter_replies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recruiter_id INTEGER NOT NULL,
      recipient_email TEXT NOT NULL COLLATE NOCASE,
      gmail_message_id TEXT NOT NULL UNIQUE,
      gmail_thread_id TEXT NOT NULL,
      subject TEXT NOT NULL DEFAULT '',
      snippet TEXT NOT NULL DEFAULT '',
      from_header TEXT NOT NULL,
      classification TEXT NOT NULL DEFAULT 'unclassified'
        CHECK (classification IN ('unclassified', 'positive_response', 'rejection', 'interview_invitation', 'other')),
      classification_reason TEXT NOT NULL DEFAULT '',
      received_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (recruiter_id) REFERENCES recruiters(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_replies_recruiter ON recruiter_replies(recruiter_id);
    CREATE INDEX IF NOT EXISTS idx_replies_thread ON recruiter_replies(gmail_thread_id);
    CREATE INDEX IF NOT EXISTS idx_replies_classification ON recruiter_replies(classification);

    CREATE TABLE IF NOT EXISTS scheduled_followups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recruiter_id INTEGER NOT NULL,
      campaign_id INTEGER,
      original_sent_email_id INTEGER NOT NULL,
      gmail_thread_id TEXT NOT NULL,
      sequence_number INTEGER NOT NULL DEFAULT 1,
      scheduled_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'draft_generated', 'cancelled', 'completed')),
      cancel_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (recruiter_id) REFERENCES recruiters(id) ON DELETE CASCADE,
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL,
      FOREIGN KEY (original_sent_email_id) REFERENCES sent_emails(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_followups_recruiter ON scheduled_followups(recruiter_id);
    CREATE INDEX IF NOT EXISTS idx_followups_thread ON scheduled_followups(gmail_thread_id);
    CREATE INDEX IF NOT EXISTS idx_followups_status ON scheduled_followups(status);
    CREATE INDEX IF NOT EXISTS idx_followups_scheduled_at ON scheduled_followups(scheduled_at);
  `);
}
