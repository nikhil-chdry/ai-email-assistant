export const id = "006-campaigns";

export function up(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS suppression_list (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL COLLATE NOCASE UNIQUE,
      reason TEXT NOT NULL DEFAULT 'unsubscribed',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_suppression_list_email ON suppression_list(email);

    CREATE TABLE IF NOT EXISTS campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      email_draft_id INTEGER NOT NULL,
      attach_active_resume INTEGER NOT NULL DEFAULT 0 CHECK (attach_active_resume IN (0, 1)),
      batch_size INTEGER NOT NULL DEFAULT 10 CHECK (batch_size >= 1 AND batch_size <= 50),
      delay_seconds_between_emails INTEGER NOT NULL DEFAULT 2 CHECK (delay_seconds_between_emails >= 0 AND delay_seconds_between_emails <= 300),
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'sending', 'paused', 'completed', 'stopped')),
      approval_hash TEXT,
      approved_at TEXT,
      approved_by TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      total_recipients INTEGER NOT NULL DEFAULT 0,
      sent_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      skipped_count INTEGER NOT NULL DEFAULT 0,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (email_draft_id) REFERENCES email_drafts(id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);
    CREATE INDEX IF NOT EXISTS idx_campaigns_created_at ON campaigns(created_at);

    CREATE TABLE IF NOT EXISTS campaign_recipients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL,
      recruiter_id INTEGER NOT NULL,
      email TEXT NOT NULL COLLATE NOCASE,
      name TEXT NOT NULL DEFAULT '',
      company TEXT NOT NULL DEFAULT '',
      job_role TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
      skip_reason TEXT,
      gmail_message_id TEXT,
      gmail_thread_id TEXT,
      error_message TEXT,
      sent_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(campaign_id, email),
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
      FOREIGN KEY (recruiter_id) REFERENCES recruiters(id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_campaign_recipients_campaign ON campaign_recipients(campaign_id);
    CREATE INDEX IF NOT EXISTS idx_campaign_recipients_email ON campaign_recipients(email);
    CREATE INDEX IF NOT EXISTS idx_campaign_recipients_status ON campaign_recipients(status);
  `);

  const tableInfo = database.all("PRAGMA table_info(sent_emails);");
  const hasCampaignId = tableInfo.some((col) => col.name === "campaign_id");
  if (!hasCampaignId) {
    database.exec(`
      ALTER TABLE sent_emails ADD COLUMN campaign_id INTEGER REFERENCES campaigns(id);
      CREATE INDEX IF NOT EXISTS idx_sent_emails_campaign_id ON sent_emails(campaign_id);
    `);
  }
}

