export const id = "003-email-drafts";

export function up(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS email_drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recruiter_id INTEGER NOT NULL,
      template TEXT NOT NULL CHECK (template IN (
        'sde_intern', 'backend_developer', 'full_stack_developer',
        'software_engineer', 'ml_engineer', 'ai_engineer'
      )),
      target_role TEXT NOT NULL,
      subject TEXT NOT NULL,
      body_text TEXT NOT NULL,
      company_information TEXT NOT NULL DEFAULT '',
      generation_context_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status = 'draft'),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (recruiter_id) REFERENCES recruiters(id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_email_drafts_recruiter_id ON email_drafts(recruiter_id);
    CREATE INDEX IF NOT EXISTS idx_email_drafts_status ON email_drafts(status);
  `);
}

