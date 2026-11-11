import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import initSqlJs from "sql.js";
import { id as initialSchemaId, up as applyInitialSchema } from "./migrations/001-initial-schema.js";
import { id as recruiterSchemaId, up as applyRecruiterSchema } from "./migrations/002-recruiters.js";
import { id as emailDraftSchemaId, up as applyEmailDraftSchema } from "./migrations/003-email-drafts.js";
import { id as gmailTokensSchemaId, up as applyGmailTokensSchema } from "./migrations/004-gmail-tokens.js";
import { id as sentEmailsSchemaId, up as applySentEmailsSchema } from "./migrations/005-sent-emails.js";

const migrations = [
  { id: initialSchemaId, up: applyInitialSchema },
  { id: recruiterSchemaId, up: applyRecruiterSchema },
  { id: emailDraftSchemaId, up: applyEmailDraftSchema },
  { id: gmailTokensSchemaId, up: applyGmailTokensSchema },
  { id: sentEmailsSchemaId, up: applySentEmailsSchema },
];

export class LocalDatabase {
  constructor({ databasePath }) {
    this.databasePath = path.resolve(databasePath);
    this.database = null;
    this.writeQueue = Promise.resolve();
  }

  async initialize() {
    const SQL = await initSqlJs({
      locateFile: (file) => path.join(path.dirname(fileURLToPath(import.meta.url)), "../../node_modules/sql.js/dist", file),
    });
    await fs.mkdir(path.dirname(this.databasePath), { recursive: true });

    let contents = null;
    try {
      contents = await fs.readFile(this.databasePath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    this.database = contents ? new SQL.Database(contents) : new SQL.Database();
    this.database.run("PRAGMA foreign_keys = ON;");
    await this.#applyMigrations();
  }

  exec(sql) {
    this.database.run(sql);
  }

  get(sql, parameters = []) {
    const statement = this.database.prepare(sql);
    try {
      statement.bind(parameters);
      return statement.step() ? statement.getAsObject() : null;
    } finally {
      statement.free();
    }
  }

  all(sql, parameters = []) {
    const statement = this.database.prepare(sql);
    try {
      statement.bind(parameters);
      const rows = [];
      while (statement.step()) rows.push(statement.getAsObject());
      return rows;
    } finally {
      statement.free();
    }
  }

  run(sql, parameters = []) {
    this.database.run(sql, parameters);
    return this.get("SELECT last_insert_rowid() AS lastInsertRowid");
  }

  async transaction(work) {
    return this.#enqueueWrite(async () => {
      this.exec("BEGIN IMMEDIATE;");
      try {
        const result = await work(this);
        this.exec("COMMIT;");
        await this.#persist();
        return result;
      } catch (error) {
        this.exec("ROLLBACK;");
        throw error;
      }
    });
  }

  async close() {
    if (!this.database) return;
    await this.writeQueue;
    this.database.close();
    this.database = null;
  }

  async #applyMigrations() {
    this.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);");
    for (const migration of migrations) {
      if (this.get("SELECT id FROM schema_migrations WHERE id = ?", [migration.id])) continue;
      this.exec("BEGIN IMMEDIATE;");
      try {
        migration.up(this);
        this.run("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)", [migration.id, new Date().toISOString()]);
        this.exec("COMMIT;");
      } catch (error) {
        this.exec("ROLLBACK;");
        throw error;
      }
    }
    await this.#persist();
  }

  #enqueueWrite(work) {
    const pending = this.writeQueue.then(work, work);
    this.writeQueue = pending.catch(() => undefined);
    return pending;
  }

  async #persist() {
    const temporaryPath = `${this.databasePath}.tmp`;
    await fs.writeFile(temporaryPath, this.database.export());
    await fs.rename(temporaryPath, this.databasePath);
  }
}

export async function createDatabase({ databasePath }) {
  const database = new LocalDatabase({ databasePath });
  await database.initialize();
  return database;
}

