import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_PROMPTS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../prompts",
);

/** Loads a versioned prompt file (e.g. "call-summary.v1"), stripping its leading comment. */
export async function loadPrompt(
  name: string,
  promptsDir: string = DEFAULT_PROMPTS_DIR,
): Promise<string> {
  const raw = await readFile(path.join(promptsDir, `${name}.md`), "utf8");
  return raw.replace(/^<!--[\s\S]*?-->\s*/, "").trim();
}
