import crypto from "node:crypto";

/**
 * Derives a 32-byte (256-bit) encryption key from the provided secret using SHA-256.
 *
 * @param {string} secret
 * @returns {Buffer}
 */
export function deriveKey(secret) {
  if (!secret || typeof secret !== "string" || secret.trim().length === 0) {
    throw new Error("TOKEN_ENCRYPTION_KEY environment variable is required for secure token encryption.");
  }
  return crypto.createHash("sha256").update(secret.trim(), "utf8").digest();
}

/**
 * Encrypts plaintext using AES-256-GCM with a random 12-byte IV.
 *
 * @param {string} plainText
 * @param {string} secret
 * @returns {string} JSON-serialized encryption envelope containing iv, tag, and data in hex.
 */
export function encryptToken(plainText, secret) {
  if (typeof plainText !== "string") {
    throw new TypeError("Plaintext to encrypt must be a string.");
  }
  const key = deriveKey(secret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return JSON.stringify({
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
    data: encrypted.toString("hex"),
  });
}

/**
 * Decrypts a JSON-serialized AES-256-GCM envelope.
 *
 * @param {string} payload
 * @param {string} secret
 * @returns {string} Decrypted plaintext.
 */
export function decryptToken(payload, secret) {
  if (!payload || typeof payload !== "string") {
    throw new TypeError("Encrypted payload must be a non-empty string.");
  }

  let envelope;
  try {
    envelope = JSON.parse(payload);
  } catch {
    throw new Error("Encrypted payload is not valid JSON.");
  }

  const { iv, tag, data } = envelope;
  if (!iv || !tag || !data) {
    throw new Error("Encrypted payload is missing required envelope fields (iv, tag, data).");
  }

  const key = deriveKey(secret);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "hex"));
  decipher.setAuthTag(Buffer.from(tag, "hex"));

  try {
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(data, "hex")),
      decipher.final(),
    ]);
    return decrypted.toString("utf8");
  } catch (error) {
    throw new Error("Failed to decrypt token: authentication failed or invalid encryption key.");
  }
}

/**
 * Generates a cryptographically secure 32-byte hex key for TOKEN_ENCRYPTION_KEY.
 *
 * @returns {string}
 */
export function generateEncryptionKey() {
  return crypto.randomBytes(32).toString("hex");
}

