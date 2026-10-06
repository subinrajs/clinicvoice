import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * True when the module is the process entry point. Resolves symlinks on both sides, because
 * pnpm installs workspace packages behind node_modules symlinks (e.g. in the Docker image).
 */
export function isEntrypoint(moduleUrl: string): boolean {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
