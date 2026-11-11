import crypto from "node:crypto";

/**
 * Encodes a string according to RFC 2047 encoded-word if it contains non-ASCII characters.
 *
 * @param {string} str
 * @returns {string}
 */
export function encodeMimeWord(str) {
  if (!str) return "";
  // Check if string contains only ASCII printable characters
  if (/^[\x20-\x7E]*$/.test(str)) {
    return str;
  }
  return `=?UTF-8?B?${Buffer.from(str, "utf8").toString("base64")}?=`;
}

/**
 * Formats an email address with optional display name.
 *
 * @param {string} [name]
 * @param {string} email
 * @returns {string}
 */
export function formatAddress(name, email) {
  const cleanEmail = email.trim();
  if (!name || name.trim().length === 0) {
    return cleanEmail;
  }
  const cleanName = name.trim();
  const encodedName = encodeMimeWord(cleanName);
  return `${encodedName} <${cleanEmail}>`;
}

/**
 * Wraps a base64 string into lines of maximum length (default 76 characters per RFC 2045).
 *
 * @param {string} base64Str
 * @param {number} [lineLength=76]
 * @returns {string}
 */
export function wrapBase64(base64Str, lineLength = 76) {
  if (!base64Str) return "";
  const regex = new RegExp(`.{1,${lineLength}}`, "g");
  return base64Str.match(regex)?.join("\r\n") || base64Str;
}

/**
 * Constructs an RFC 2822 / MIME compliant email message.
 *
 * @param {object} options
 * @param {string} options.fromEmail
 * @param {string} [options.fromName]
 * @param {string} options.toEmail
 * @param {string} [options.toName]
 * @param {string} options.subject
 * @param {string} options.bodyText
 * @param {string} [options.bodyHtml]
 * @param {object} [options.attachment]
 * @param {string} options.attachment.filename
 * @param {Buffer} options.attachment.content
 * @param {string} [options.attachment.mimeType="application/pdf"]
 * @returns {string} The full MIME message string with CRLF line endings.
 */
export function buildMimeMessage({
  fromEmail,
  fromName,
  toEmail,
  toName,
  subject,
  bodyText,
  bodyHtml,
  attachment,
}) {
  if (!fromEmail || !toEmail) {
    throw new Error("Both fromEmail and toEmail are required to build a MIME message.");
  }
  if (!subject) {
    throw new Error("Subject is required to build a MIME message.");
  }
  if (!bodyText && !bodyHtml) {
    throw new Error("Either bodyText or bodyHtml is required to build a MIME message.");
  }

  const boundaryId = crypto.randomBytes(12).toString("hex");
  const mixedBoundary = `boundary_mixed_${boundaryId}`;
  const altBoundary = `boundary_alt_${boundaryId}`;

  const fromDomain = fromEmail.split("@")[1] || "gmail.com";
  const messageId = `<${crypto.randomUUID()}@${fromDomain}>`;
  const dateStr = new Date().toUTCString();

  const headers = [
    `From: ${formatAddress(fromName, fromEmail)}`,
    `To: ${formatAddress(toName, toEmail)}`,
    `Subject: ${encodeMimeWord(subject)}`,
    `Date: ${dateStr}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
  ];

  const hasAttachment = Boolean(attachment && attachment.content);
  const hasBothTextAndHtml = Boolean(bodyText && bodyHtml);

  // Helper to build the text/html body part
  function buildAlternativePart() {
    const lines = [];
    lines.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`, "");
    lines.push(`--${altBoundary}`);
    lines.push('Content-Type: text/plain; charset="UTF-8"');
    lines.push("Content-Transfer-Encoding: base64", "");
    lines.push(wrapBase64(Buffer.from(bodyText || "", "utf8").toString("base64")), "");
    lines.push(`--${altBoundary}`);
    lines.push('Content-Type: text/html; charset="UTF-8"');
    lines.push("Content-Transfer-Encoding: base64", "");
    lines.push(wrapBase64(Buffer.from(bodyHtml, "utf8").toString("base64")), "");
    lines.push(`--${altBoundary}--`);
    return lines.join("\r\n");
  }

  function buildSingleTextPart() {
    const lines = [];
    lines.push('Content-Type: text/plain; charset="UTF-8"');
    lines.push("Content-Transfer-Encoding: base64", "");
    lines.push(wrapBase64(Buffer.from(bodyText, "utf8").toString("base64")));
    return lines.join("\r\n");
  }

  function buildSingleHtmlPart() {
    const lines = [];
    lines.push('Content-Type: text/html; charset="UTF-8"');
    lines.push("Content-Transfer-Encoding: base64", "");
    lines.push(wrapBase64(Buffer.from(bodyHtml, "utf8").toString("base64")));
    return lines.join("\r\n");
  }

  function buildBodySection() {
    if (hasBothTextAndHtml) return buildAlternativePart();
    if (bodyHtml) return buildSingleHtmlPart();
    return buildSingleTextPart();
  }

  if (hasAttachment) {
    const mimeType = attachment.mimeType || "application/pdf";
    const cleanFilename = attachment.filename || "attachment.pdf";
    const encodedFilename = encodeMimeWord(cleanFilename);
    const attachmentBase64 = wrapBase64(attachment.content.toString("base64"));

    headers.push(`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`);

    const messageLines = [
      ...headers,
      "",
      `--${mixedBoundary}`,
      buildBodySection(),
      `--${mixedBoundary}`,
      `Content-Type: ${mimeType}; name="${encodedFilename}"`,
      `Content-Disposition: attachment; filename="${encodedFilename}"`,
      "Content-Transfer-Encoding: base64",
      "",
      attachmentBase64,
      `--${mixedBoundary}--`,
    ];

    return messageLines.join("\r\n");
  }

  // Without attachment
  if (hasBothTextAndHtml) {
    headers.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
    const messageLines = [
      ...headers,
      "",
      `--${altBoundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      wrapBase64(Buffer.from(bodyText, "utf8").toString("base64")),
      `--${altBoundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      wrapBase64(Buffer.from(bodyHtml, "utf8").toString("base64")),
      `--${altBoundary}--`,
    ];
    return messageLines.join("\r\n");
  }

  // Single plain text or single html
  if (bodyHtml) {
    headers.push('Content-Type: text/html; charset="UTF-8"');
    headers.push("Content-Transfer-Encoding: base64");
    return [...headers, "", wrapBase64(Buffer.from(bodyHtml, "utf8").toString("base64"))].join("\r\n");
  }

  headers.push('Content-Type: text/plain; charset="UTF-8"');
  headers.push("Content-Transfer-Encoding: base64");
  return [...headers, "", wrapBase64(Buffer.from(bodyText, "utf8").toString("base64"))].join("\r\n");
}

/**
 * Converts a MIME message string to a URL-safe base64 string required by Gmail messages.send.
 *
 * @param {string} mimeString
 * @returns {string} URL-safe base64 without padding.
 */
export function encodeRawForGmail(mimeString) {
  return Buffer.from(mimeString, "utf8").toString("base64url");
}
