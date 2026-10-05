import { createHmac } from "node:crypto";

/**
 * Stores caller numbers as a keyed hash: still usable for rate limiting and lockouts by caller,
 * but not reversible without the key.
 */
export function hashPhone(e164: string, key: string): string {
  return createHmac("sha256", key).update(e164.trim()).digest("hex");
}
