import { parseRecruiterCsv } from "../utils/csv-parser.js";

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const statuses = new Set(["new", "contacted", "replied", "do_not_contact", "archived"]);

function formatIsValid(email) {
  return emailPattern.test(email) && email.length <= 254;
}

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeRecruiter(input) {
  const email = normalizeText(input.email).toLowerCase();
  return {
    name: normalizeText(input.name),
    email,
    company: normalizeText(input.company),
    designation: normalizeText(input.designation),
    jobRole: normalizeText(input.jobRole ?? input.job_role),
    companyWebsite: normalizeText(input.companyWebsite ?? input.company_website),
    publicProfessionalInfo: normalizeText(input.publicProfessionalInfo ?? input.public_professional_info),
    source: normalizeText(input.source),
    outreachStatus: input.outreachStatus ?? input.outreach_status ?? "new",
    lastContactedAt: input.lastContactedAt ?? input.last_contacted_at ?? null,
  };
}

function toRecruiter(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    company: row.company,
    designation: row.designation,
    jobRole: row.job_role,
    companyWebsite: row.company_website,
    publicProfessionalInfo: row.public_professional_info,
    source: row.source,
    importedAt: row.imported_at,
    lastContactedAt: row.last_contacted_at,
    outreachStatus: row.outreach_status,
    emailFormatValid: Boolean(row.email_format_valid),
    emailVerification: "format-only; deliverability is not verified",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function buildWhere(filters = {}) {
  const clauses = [];
  const values = [];
  if (filters.company) {
    clauses.push("LOWER(company) LIKE ?");
    values.push(`%${filters.company.toLowerCase()}%`);
  }
  if (filters.jobRole) {
    clauses.push("LOWER(job_role) LIKE ?");
    values.push(`%${filters.jobRole.toLowerCase()}%`);
  }
  if (filters.outreachStatus) {
    clauses.push("outreach_status = ?");
    values.push(filters.outreachStatus);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", values };
}

export class RecruiterService {
  constructor({ database }) {
    this.database = database;
  }

  async importFromCsv({ sourcePath, defaultSource = "", dryRun = false }) {
    const rows = await parseRecruiterCsv(sourcePath);
    const normalizedRows = rows.map((row, index) => ({ row: normalizeRecruiter(row), rowNumber: index + 2 }));
    const seenEmails = new Set();
    const accepted = [];
    const rejected = [];

    for (const entry of normalizedRows) {
      const recruiter = { ...entry.row, source: entry.row.source || defaultSource };
      if (!recruiter.name || !recruiter.email) {
        rejected.push({ row: entry.rowNumber, reason: "name and email are required" });
      } else if (seenEmails.has(recruiter.email)) {
        rejected.push({ row: entry.rowNumber, reason: "duplicate email within CSV" });
      } else {
        seenEmails.add(recruiter.email);
        accepted.push({ ...entry, row: recruiter });
      }
    }

    const existingEmails = new Set();
    for (const entry of accepted) {
      if (this.database.get("SELECT id FROM recruiters WHERE email = ?", [entry.row.email])) {
        existingEmails.add(entry.row.email);
      }
    }
    const insertable = accepted.filter((entry) => !existingEmails.has(entry.row.email));
    if (!dryRun && insertable.length) {
      await this.database.transaction((database) => {
        const now = new Date().toISOString();
        for (const entry of insertable) {
          const recruiter = entry.row;
          database.run(
            `INSERT INTO recruiters (
              name, email, company, designation, job_role, company_website,
              public_professional_info, source, imported_at, last_contacted_at, outreach_status,
              email_format_valid, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              recruiter.name, recruiter.email, recruiter.company, recruiter.designation,
              recruiter.jobRole, recruiter.companyWebsite, recruiter.publicProfessionalInfo,
              recruiter.source, now, recruiter.lastContactedAt, recruiter.outreachStatus, Number(formatIsValid(recruiter.email)), now, now,
            ],
          );
        }
      });
    }

    return {
      dryRun,
      totalRows: rows.length,
      imported: dryRun ? 0 : insertable.length,
      wouldImport: insertable.length,
      skippedExisting: [...existingEmails].length,
      rejected,
      invalidEmailFormatCount: insertable.filter((entry) => !formatIsValid(entry.row.email)).length,
      note: "Email checks validate syntax only; they do not verify ownership or deliverability.",
    };
  }

  async create(input) {
    const recruiter = normalizeRecruiter(input);
    if (!recruiter.name || !recruiter.email) throw new Error("Recruiter name and email are required.");
    if (!statuses.has(recruiter.outreachStatus)) throw new Error("Invalid outreach status.");
    if (this.database.get("SELECT id FROM recruiters WHERE email = ?", [recruiter.email])) {
      throw new Error("A recruiter with this email address already exists.");
    }
    const created = await this.database.transaction((database) => {
      const now = new Date().toISOString();
      const id = database.run(
        `INSERT INTO recruiters (
          name, email, company, designation, job_role, company_website,
          public_professional_info, source, imported_at, last_contacted_at, outreach_status,
          email_format_valid, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          recruiter.name, recruiter.email, recruiter.company, recruiter.designation,
          recruiter.jobRole, recruiter.companyWebsite, recruiter.publicProfessionalInfo,
          recruiter.source, now, recruiter.lastContactedAt, recruiter.outreachStatus, Number(formatIsValid(recruiter.email)), now, now,
        ],
      ).lastInsertRowid;
      return database.get("SELECT * FROM recruiters WHERE id = ?", [id]);
    });
    return toRecruiter(created);
  }

  getById(id) {
    const row = this.database.get("SELECT * FROM recruiters WHERE id = ?", [id]);
    if (!row) throw new Error("Recruiter not found.");
    return toRecruiter(row);
  }

  list({ limit = 50, offset = 0, ...filters } = {}) {
    const { where, values } = buildWhere(filters);
    const rows = this.database.all(
      `SELECT * FROM recruiters ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...values, limit, offset],
    );
    const total = this.database.get(`SELECT COUNT(*) AS count FROM recruiters ${where}`, values).count;
    return { recruiters: rows.map(toRecruiter), total, limit, offset };
  }

  search({ query, limit = 50, offset = 0 }) {
    const like = `%${query.toLowerCase()}%`;
    const rows = this.database.all(
      `SELECT * FROM recruiters
       WHERE LOWER(name) LIKE ? OR LOWER(email) LIKE ? OR LOWER(company) LIKE ?
          OR LOWER(designation) LIKE ? OR LOWER(job_role) LIKE ?
       ORDER BY id DESC LIMIT ? OFFSET ?`,
      [like, like, like, like, like, limit, offset],
    );
    const total = this.database.get(
      `SELECT COUNT(*) AS count FROM recruiters
       WHERE LOWER(name) LIKE ? OR LOWER(email) LIKE ? OR LOWER(company) LIKE ?
          OR LOWER(designation) LIKE ? OR LOWER(job_role) LIKE ?`,
      [like, like, like, like, like],
    ).count;
    return { recruiters: rows.map(toRecruiter), total, limit, offset };
  }

  async validateContacts({ recruiterIds } = {}) {
    const placeholders = recruiterIds?.length ? recruiterIds.map(() => "?").join(", ") : null;
    const rows = this.database.all(
      `SELECT * FROM recruiters ${placeholders ? `WHERE id IN (${placeholders})` : ""} ORDER BY id DESC`,
      recruiterIds ?? [],
    );
    await this.database.transaction((database) => {
      for (const recruiter of rows) {
        database.run("UPDATE recruiters SET email_format_valid = ?, updated_at = ? WHERE id = ?", [
          Number(formatIsValid(recruiter.email)), new Date().toISOString(), recruiter.id,
        ]);
      }
    });
    const contacts = rows.map((row) => ({
      id: row.id,
      email: row.email,
      emailFormatValid: formatIsValid(row.email),
      emailVerification: "format-only; deliverability is not verified",
    }));
    return {
      checked: contacts.length,
      formatValid: contacts.filter((contact) => contact.emailFormatValid).length,
      contacts,
    };
  }

  async update(id, updates) {
    const current = this.database.get("SELECT * FROM recruiters WHERE id = ?", [id]);
    if (!current) throw new Error("Recruiter not found.");
    const next = normalizeRecruiter({ ...toRecruiter(current), ...updates });
    if (!next.name || !next.email) throw new Error("Recruiter name and email are required.");
    if (!statuses.has(next.outreachStatus)) throw new Error("Invalid outreach status.");
    const duplicate = this.database.get("SELECT id FROM recruiters WHERE email = ? AND id != ?", [next.email, id]);
    if (duplicate) throw new Error("Another recruiter already uses this email address.");

    await this.database.transaction((database) => {
      database.run(
        `UPDATE recruiters SET
          name = ?, email = ?, company = ?, designation = ?, job_role = ?, company_website = ?,
          public_professional_info = ?, source = ?, last_contacted_at = ?, outreach_status = ?, email_format_valid = ?, updated_at = ?
         WHERE id = ?`,
        [
          next.name, next.email, next.company, next.designation, next.jobRole, next.companyWebsite,
          next.publicProfessionalInfo, next.source, next.lastContactedAt, next.outreachStatus, Number(formatIsValid(next.email)),
          new Date().toISOString(), id,
        ],
      );
    });
    return toRecruiter(this.database.get("SELECT * FROM recruiters WHERE id = ?", [id]));
  }

  async delete(id) {
    const current = this.database.get("SELECT id FROM recruiters WHERE id = ?", [id]);
    if (!current) throw new Error("Recruiter not found.");
    await this.database.transaction((database) => {
      database.run("DELETE FROM recruiters WHERE id = ?", [id]);
    });
    return { deleted: true, id };
  }
}

