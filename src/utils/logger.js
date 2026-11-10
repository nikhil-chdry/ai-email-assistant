/**
 * MCP stdio reserves stdout for JSON-RPC. All diagnostics must use stderr.
 */
export function logInfo(message, details) {
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  process.stderr.write(`[ai-email-assistant] ${message}${suffix}\n`);
}

export function logError(message, error) {
  const details = error instanceof Error ? { message: error.message } : error;
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  process.stderr.write(`[ai-email-assistant] ERROR: ${message}${suffix}\n`);
}

