import { createHash, randomBytes } from "node:crypto";

// The prefix tells a leaked secret's kind at a glance and lets secret
// scanners match it. Site keys and agent tokens are never interchangeable.
export const SITE_KEY_PREFIX = "fbs_";
export const AGENT_TOKEN_PREFIX = "fba_";

export function generateSecret(prefix: string): string {
  return prefix + randomBytes(32).toString("base64url");
}

// The secrets carry 256 random bits, so a plain SHA-256 is enough; a slow
// password hash would only cost time on every request.
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}
