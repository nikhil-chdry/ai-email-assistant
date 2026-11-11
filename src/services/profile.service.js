import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { extractPdfText } from "../utils/pdf-parser.js";

const MAX_RESUME_BYTES = 10 * 1024 * 1024;
const pdfSignature = Buffer.from("%PDF-");

const initialProfile = {
  fullName: "Nikhil Sunda",
  college: "IIIT Bhubaneswar",
  degree: "B.Tech Electrical and Electronics Engineering",
  graduationBatch: "2023–2027",
  careerPreference: "IT sector and Software Engineering, not core EEE.",
  technicalSkills: ["C++", "Data Structures and Algorithms", "JavaScript", "React.js", "Node.js", "Express.js", "MongoDB", "REST APIs", "Tailwind CSS", "Python", "Machine Learning", "Deep Learning"],
  projects: ["Water AMC Management System", "Privacy Scanner", "Smart Shop Platform", "Razorpay frontend clone", "Personal portfolio website"],
  research: "Smart IoT-Based Predictive Analytics for Enhancing EV Battery Efficiency and Cooling Systems.",
};

function toProfile(row) {
  return {
    fullName: row.full_name,
    college: row.college,
    degree: row.degree,
    graduationBatch: row.graduation_batch,
    careerPreference: row.career_preference,
    technicalSkills: JSON.parse(row.technical_skills_json),
    projects: JSON.parse(row.projects_json),
    research: row.research_json,
    source: row.profile_source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    hasResume: Boolean(row.resume_id),
  };
}

export class ProfileService {
  constructor({ database, uploadsDirectory }) {
    this.database = database;
    this.uploadsDirectory = path.resolve(uploadsDirectory);
  }

  async ensureInitialProfile() {
    await this.database.transaction((database) => {
      if (database.get("SELECT id FROM candidate_profiles WHERE id = 1")) return;
      const now = new Date().toISOString();
      database.run(
        `INSERT INTO candidate_profiles (
          id, full_name, college, degree, graduation_batch, career_preference,
          technical_skills_json, projects_json, research_json, resume_id,
          profile_source, created_at, updated_at
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
        [
          initialProfile.fullName,
          initialProfile.college,
          initialProfile.degree,
          initialProfile.graduationBatch,
          initialProfile.careerPreference,
          JSON.stringify(initialProfile.technicalSkills),
          JSON.stringify(initialProfile.projects),
          initialProfile.research,
          "Initial user-provided profile; professional claims are unverified until supported by the uploaded resume.",
          now,
          now,
        ],
      );
    });
  }

  getProfile() {
    const row = this.database.get("SELECT * FROM candidate_profiles WHERE id = 1");
    return toProfile(row);
  }

  async updateProfile(updates) {
    const map = {
      fullName: "full_name",
      college: "college",
      degree: "degree",
      graduationBatch: "graduation_batch",
      careerPreference: "career_preference",
      technicalSkills: "technical_skills_json",
      projects: "projects_json",
      research: "research_json",
    };
    const assignments = [];
    const values = [];
    for (const [key, column] of Object.entries(map)) {
      if (updates[key] === undefined) continue;
      assignments.push(`${column} = ?`);
      values.push(["technicalSkills", "projects"].includes(key) ? JSON.stringify(updates[key]) : updates[key]);
    }
    if (!assignments.length) throw new Error("At least one editable profile field is required.");

    await this.database.transaction((database) => {
      database.run(
        `UPDATE candidate_profiles SET ${assignments.join(", ")}, updated_at = ? WHERE id = 1`,
        [...values, new Date().toISOString()],
      );
    });
    return this.getProfile();
  }

  async uploadResume({ sourcePath, confirmReplace }) {
    const resolvedSource = path.resolve(sourcePath);
    if (path.extname(resolvedSource).toLowerCase() !== ".pdf") {
      throw new Error("Resume uploads must be PDF files.");
    }

    let source;
    try {
      source = await fs.readFile(resolvedSource);
    } catch {
      throw new Error("The selected resume file could not be read.");
    }
    if (source.length === 0 || source.length > MAX_RESUME_BYTES) {
      throw new Error("Resume must be a non-empty PDF no larger than 10 MB.");
    }
    if (!source.subarray(0, pdfSignature.length).equals(pdfSignature)) {
      throw new Error("The selected file is not a valid PDF upload.");
    }
    if (this.getProfile().hasResume && !confirmReplace) {
      throw new Error("A resume is already stored. Set confirmReplace to true to replace it.");
    }

    let extractedText;
    try {
      extractedText = await extractPdfText(source);
    } catch {
      throw new Error("The PDF could not be parsed. Upload a readable, non-password-protected PDF.");
    }
    if (!extractedText) throw new Error("The PDF contains no extractable text.");

    const sha256 = crypto.createHash("sha256").update(source).digest("hex");
    const alreadyStored = this.database.get("SELECT * FROM resumes WHERE sha256 = ?", [sha256]);
    if (alreadyStored) {
      await this.database.transaction((database) => {
        database.run("UPDATE candidate_profiles SET resume_id = ?, updated_at = ? WHERE id = 1", [alreadyStored.id, new Date().toISOString()]);
      });
      return this.#resumeMetadata(alreadyStored);
    }

    const storedFilename = `${crypto.randomUUID()}.pdf`;
    const destination = path.join(this.uploadsDirectory, "resumes", storedFilename);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, source, { flag: "wx" });

    try {
      const resume = await this.database.transaction((database) => {
        const now = new Date().toISOString();
        const existing = database.get("SELECT id FROM resumes WHERE sha256 = ?", [sha256]);
        const resumeId = existing?.id ?? database.run(
          `INSERT INTO resumes (original_filename, stored_filename, mime_type, size_bytes, sha256, extracted_text, uploaded_at)
           VALUES (?, ?, 'application/pdf', ?, ?, ?, ?)`,
          [path.basename(resolvedSource), storedFilename, source.length, sha256, extractedText, now],
        ).lastInsertRowid;
        database.run("UPDATE candidate_profiles SET resume_id = ?, updated_at = ? WHERE id = 1", [resumeId, now]);
        return database.get("SELECT * FROM resumes WHERE id = ?", [resumeId]);
      });
      return this.#resumeMetadata(resume);
    } catch (error) {
      await fs.rm(destination, { force: true });
      throw error;
    }
  }

  getResumeInformation() {
    const resume = this.database.get(
      `SELECT resumes.* FROM candidate_profiles
       JOIN resumes ON resumes.id = candidate_profiles.resume_id
       WHERE candidate_profiles.id = 1`,
    );
    if (!resume) return { hasResume: false, message: "No resume has been uploaded." };
    return { hasResume: true, ...this.#resumeMetadata(resume), extractedText: resume.extracted_text };
  }

  /**
   * Retrieves the active resume file content and metadata for internal attachment handling.
   * Never expose the returned storage path or binary to MCP tool outputs.
   *
   * @returns {Promise<{ id: number, originalFilename: string, mimeType: string, sizeBytes: number, buffer: Buffer } | null>}
   */
  async getActiveResumeFile() {
    const resume = this.database.get(
      `SELECT resumes.* FROM candidate_profiles
       JOIN resumes ON resumes.id = candidate_profiles.resume_id
       WHERE candidate_profiles.id = 1`,
    );
    if (!resume) return null;

    const baseDir = path.resolve(this.uploadsDirectory, "resumes");
    const resolvedPath = path.resolve(baseDir, resume.stored_filename);

    if (!resolvedPath.startsWith(baseDir + path.sep) && resolvedPath !== baseDir) {
      throw new Error("Invalid resume storage path detected.");
    }

    let buffer;
    try {
      buffer = await fs.readFile(resolvedPath);
    } catch {
      throw new Error("Active resume file could not be read from storage.");
    }

    if (buffer.length === 0 || buffer.length > MAX_RESUME_BYTES) {
      throw new Error("Active resume exceeds allowable size limit (10 MB).");
    }

    if (!buffer.subarray(0, pdfSignature.length).equals(pdfSignature)) {
      throw new Error("Active resume file signature is invalid.");
    }

    return {
      id: resume.id,
      originalFilename: resume.original_filename,
      mimeType: resume.mime_type,
      sizeBytes: buffer.length,
      buffer,
    };
  }

  #resumeMetadata(resume) {
    return {
      id: resume.id,
      originalFilename: resume.original_filename,
      mimeType: resume.mime_type,
      sizeBytes: resume.size_bytes,
      uploadedAt: resume.uploaded_at,
      extractedTextLength: resume.extracted_text.length,
    };
  }
}

