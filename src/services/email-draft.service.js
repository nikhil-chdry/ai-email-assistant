const templates = {
  sde_intern: { label: "SDE Intern", targetRole: "SDE Intern", focus: "software fundamentals, relevant projects, and internship interest" },
  backend_developer: { label: "Backend Developer", targetRole: "Backend Developer", focus: "backend systems, APIs, Node.js, and data handling" },
  full_stack_developer: { label: "Full Stack Developer", targetRole: "Full Stack Developer", focus: "end-to-end JavaScript development and relevant projects" },
  software_engineer: { label: "Software Engineer", targetRole: "Software Engineer", focus: "software engineering fundamentals and practical project work" },
  ml_engineer: { label: "ML Engineer", targetRole: "ML Engineer", focus: "Python, machine learning, deep learning, and relevant research or projects" },
  ai_engineer: { label: "AI Engineer", targetRole: "AI Engineer", focus: "AI/ML work, engineering ability, and relevant research or projects" },
};

function wordCount(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function draftChecks({ subject, body }) {
  const count = wordCount(body);
  const warnings = [];
  if (count < 100 || count > 160) warnings.push(`Body is ${count} words; the preferred range is 100–160 words.`);
  if (!subject.trim()) warnings.push("A concise subject is required.");
  return { wordCount: count, warnings };
}

function toDraft(row) {
  const checks = draftChecks({ subject: row.subject, body: row.body_text });
  return {
    id: row.id,
    recruiterId: row.recruiter_id,
    template: row.template,
    targetRole: row.target_role,
    subject: row.subject,
    body: row.body_text,
    companyInformation: row.company_information,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...checks,
  };
}

export class EmailDraftService {
  constructor({ database, profileService, recruiterService }) {
    this.database = database;
    this.profileService = profileService;
    this.recruiterService = recruiterService;
  }

  generateBrief({ recruiterId, template, companyInformation = "" }) {
    const templateDefinition = templates[template];
    if (!templateDefinition) throw new Error("Unsupported email template.");
    const recruiter = this.recruiterService.getById(recruiterId);
    const profile = this.profileService.getProfile();
    const resume = this.profileService.getResumeInformation();
    const resumeEvidence = resume.hasResume
      ? resume.extractedText.slice(0, 16_000)
      : "No resume has been uploaded. Treat the profile as user-provided and do not strengthen or invent claims.";

    return {
      mode: "client-side AI writing required",
      template: { key: template, ...templateDefinition },
      recruiter: {
        id: recruiter.id,
        name: recruiter.name,
        company: recruiter.company,
        designation: recruiter.designation,
        targetJobRole: recruiter.jobRole || templateDefinition.targetRole,
        publicProfessionalInfo: recruiter.publicProfessionalInfo,
      },
      candidateProfile: profile,
      resumeEvidence: {
        available: resume.hasResume,
        text: resumeEvidence,
        truncated: resume.hasResume && resume.extractedText.length > resumeEvidence.length,
      },
      suppliedCompanyInformation: companyInformation,
      instructions: [
        "Write the email yourself in this AI client. Do not call a paid AI API or claim the backend generated it.",
        "Use only facts supported by the active resume or the user-provided profile. Never invent work experience, certifications, achievements, or company connections.",
        "Keep the email professional, natural, concise, and preferably 100–160 words.",
        "Include a specific subject, greeting, brief introduction, relevant truthful skills or project/research detail, a request for an opportunity, and a professional closing.",
        "Avoid generic mass-mailing language, unnecessary flattery, and claims that an email address has been verified.",
        `Prioritize ${templateDefinition.focus}.`,
        "After composing, call save_email_draft with the final subject and body. Do not send the email.",
      ],
    };
  }

  async save({ recruiterId, template, subject, body, companyInformation = "" }) {
    const brief = this.generateBrief({ recruiterId, template, companyInformation });
    const now = new Date().toISOString();
    const targetRole = brief.recruiter.targetJobRole || brief.template.targetRole;
    const contextSnapshot = {
      recruiter: brief.recruiter,
      candidateProfileUpdatedAt: brief.candidateProfile.updatedAt,
      resumeAvailable: brief.resumeEvidence.available,
      companyInformation,
    };
    const id = await this.database.transaction((database) => database.run(
      `INSERT INTO email_drafts (
        recruiter_id, template, target_role, subject, body_text, company_information,
        generation_context_json, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
      [recruiterId, template, targetRole, subject.trim(), body.trim(), companyInformation.trim(), JSON.stringify(contextSnapshot), now, now],
    ).lastInsertRowid);
    return toDraft(this.database.get("SELECT * FROM email_drafts WHERE id = ?", [id]));
  }

  list({ recruiterId, limit = 50, offset = 0 } = {}) {
    const filters = recruiterId ? { where: "WHERE recruiter_id = ?", values: [recruiterId] } : { where: "", values: [] };
    const rows = this.database.all(
      `SELECT * FROM email_drafts ${filters.where} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...filters.values, limit, offset],
    );
    const total = this.database.get(`SELECT COUNT(*) AS count FROM email_drafts ${filters.where}`, filters.values).count;
    return { drafts: rows.map(toDraft), total, limit, offset };
  }

  async update(id, updates) {
    const current = this.database.get("SELECT * FROM email_drafts WHERE id = ?", [id]);
    if (!current) throw new Error("Email draft not found.");
    const next = {
      template: updates.template ?? current.template,
      subject: updates.subject ?? current.subject,
      body: updates.body ?? current.body_text,
      companyInformation: updates.companyInformation ?? current.company_information,
    };
    if (!templates[next.template]) throw new Error("Unsupported email template.");
    const brief = this.generateBrief({ recruiterId: current.recruiter_id, template: next.template, companyInformation: next.companyInformation });
    await this.database.transaction((database) => {
      database.run(
        `UPDATE email_drafts SET template = ?, target_role = ?, subject = ?, body_text = ?,
         company_information = ?, generation_context_json = ?, updated_at = ? WHERE id = ?`,
        [
          next.template, brief.recruiter.targetJobRole || brief.template.targetRole, next.subject.trim(), next.body.trim(),
          next.companyInformation.trim(), JSON.stringify({
            recruiter: brief.recruiter,
            candidateProfileUpdatedAt: brief.candidateProfile.updatedAt,
            resumeAvailable: brief.resumeEvidence.available,
            companyInformation: next.companyInformation,
          }), new Date().toISOString(), id,
        ],
      );
    });
    return toDraft(this.database.get("SELECT * FROM email_drafts WHERE id = ?", [id]));
  }

  async delete(id) {
    if (!this.database.get("SELECT id FROM email_drafts WHERE id = ?", [id])) throw new Error("Email draft not found.");
    await this.database.transaction((database) => database.run("DELETE FROM email_drafts WHERE id = ?", [id]));
    return { deleted: true, id };
  }
}

export const emailTemplates = Object.keys(templates);

