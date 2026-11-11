export const id = "001-initial-schema";

export function up(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS candidate_profiles (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      full_name TEXT NOT NULL,
      college TEXT NOT NULL,
      degree TEXT NOT NULL,
      graduation_batch TEXT NOT NULL,
      career_preference TEXT NOT NULL,
      technical_skills_json TEXT NOT NULL,
      projects_json TEXT NOT NULL,
      research_json TEXT NOT NULL,
      resume_id INTEGER,
      profile_source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (resume_id) REFERENCES resumes(id)
    );

    CREATE TABLE IF NOT EXISTS resumes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      original_filename TEXT NOT NULL,
      stored_filename TEXT NOT NULL UNIQUE,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
      sha256 TEXT NOT NULL UNIQUE,
      extracted_text TEXT NOT NULL,
      uploaded_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_resumes_uploaded_at ON resumes(uploaded_at);
  `);
}

