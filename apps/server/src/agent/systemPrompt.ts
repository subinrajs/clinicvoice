import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ClinicRepository } from "../repositories/clinicRepository.js";
import { speakableHours } from "../tools/getClinicInfo.js";

export const VOICE_AGENT_PROMPT_VERSION = "voice-agent.v1";

const PROMPTS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../prompts",
);

/**
 * Builds the static system prompt once at startup. Clinic facts come from the database, not the
 * prompt file, so the prompt never drifts from what get_clinic_info returns.
 */
export async function loadVoiceAgentPrompt(
  repo: ClinicRepository,
  promptsDir = PROMPTS_DIR,
): Promise<string> {
  const template = await readFile(
    path.join(promptsDir, `${VOICE_AGENT_PROMPT_VERSION}.md`),
    "utf8",
  );
  const sites = await repo.listSites();
  const facts = sites
    .map(
      (s) =>
        `- ${s.name}, ${s.address}. Scans: ${s.modalities.join(" and ")}. Hours: ${speakableHours(s.hours)}. Parking: ${s.parking}`,
    )
    .join("\n");
  return template.replace(/<!--[\s\S]*?-->\n*/, "").replace("{{CLINIC_FACTS}}", facts);
}
