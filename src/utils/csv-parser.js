import fs from "node:fs/promises";
import path from "node:path";
import { parse } from "csv-parse/sync";

const MAX_CSV_BYTES = 5 * 1024 * 1024;
const requiredHeaders = ["name", "email"];
const supportedHeaders = new Set([
  "name", "email", "company", "designation", "job_role", "company_website",
  "public_professional_info", "source",
]);

function normalizeHeader(header) {
  return String(header).replace(/^\uFEFF/, "").trim().toLowerCase();
}

export async function parseRecruiterCsv(sourcePath) {
  const resolvedPath = path.resolve(sourcePath);
  if (path.extname(resolvedPath).toLowerCase() !== ".csv") {
    throw new Error("Recruiter imports must be CSV files.");
  }

  let file;
  try {
    file = await fs.readFile(resolvedPath);
  } catch {
    throw new Error("The selected CSV file could not be read.");
  }
  if (!file.length || file.length > MAX_CSV_BYTES) {
    throw new Error("CSV imports must be non-empty and no larger than 5 MB.");
  }

  let rows;
  try {
    rows = parse(file, {
      bom: true,
      columns: (headers) => headers.map(normalizeHeader),
      skip_empty_lines: true,
      trim: true,
      relax_column_count: false,
    });
  } catch {
    throw new Error("The CSV could not be parsed. Check quoting and column counts.");
  }
  if (!rows.length) throw new Error("The CSV contains no recruiter rows.");

  const headers = Object.keys(rows[0] ?? {});
  for (const header of requiredHeaders) {
    if (!headers.includes(header)) throw new Error(`CSV is missing the required '${header}' column.`);
  }
  const unsupported = headers.filter((header) => !supportedHeaders.has(header));
  if (unsupported.length) throw new Error(`Unsupported CSV column(s): ${unsupported.join(", ")}.`);
  return rows;
}

