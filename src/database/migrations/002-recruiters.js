export const id = "002-recruiters";

export function up(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS recruiters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL COLLATE NOCASE UNIQUE,
      company TEXT NOT NULL DEFAULT '',
      designation TEXT NOT NULL DEFAULT '',
      job_role TEXT NOT NULL DEFAULT '',
      company_website TEXT NOT NULL DEFAULT '',
      public_professional_info TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      imported_at TEXT NOT NULL,
      last_contacted_at TEXT,
      outreach_status TEXT NOT NULL DEFAULT 'new'
        CHECK (outreach_status IN ('new', 'contacted', 'replied', 'do_not_contact', 'archived')),
      email_format_valid INTEGER NOT NULL DEFAULT 0 CHECK (email_format_valid IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_recruiters_company ON recruiters(company);
    CREATE INDEX IF NOT EXISTS idx_recruiters_job_role ON recruiters(job_role);
    CREATE INDEX IF NOT EXISTS idx_recruiters_outreach_status ON recruiters(outreach_status);
  `);
}

