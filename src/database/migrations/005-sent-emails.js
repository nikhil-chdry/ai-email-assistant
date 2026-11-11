export const id = "005-sent-emails";

export function up(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS sent_emails (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipient_email TEXT NOT NULL,
      recipient_name TEXT NOT NULL DEFAULT '',
      recruiter_id INTEGER,
      email_draft_id INTEGER,
      subject TEXT NOT NULL,
      body_text TEXT NOT NULL,
      body_html TEXT,
      has_attachment INTEGER NOT NULL DEFAULT 0 CHECK (has_attachment IN (0, 1)),
      attachment_filename TEXT,
      attachment_size_bytes INTEGER,
      gmail_message_id TEXT,
      gmail_thread_id TEXT,
      send_type TEXT NOT NULL DEFAULT 'test' CHECK (send_type IN ('test', 'campaign')),
      status TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
      error_message TEXT,
      sent_at TEXT NOT NULL,
      FOREIGN KEY (recruiter_id) REFERENCES recruiters(id) ON DELETE SET NULL,
      FOREIGN KEY (email_draft_id) REFERENCES email_drafts(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sent_emails_recipient ON sent_emails(recipient_email);
    CREATE INDEX IF NOT EXISTS idx_sent_emails_gmail_msg_id ON sent_emails(gmail_message_id);
    CREATE INDEX IF NOT EXISTS idx_sent_emails_gmail_thread_id ON sent_emails(gmail_thread_id);
    CREATE INDEX IF NOT EXISTS idx_sent_emails_send_type ON sent_emails(send_type);
    CREATE INDEX IF NOT EXISTS idx_sent_emails_sent_at ON sent_emails(sent_at);
  `);
}

