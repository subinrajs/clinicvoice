import type { ClinicRepository } from "../repositories/clinicRepository.js";
import { speakableHours } from "../tools/getClinicInfo.js";
import { DEFAULT_PROMPTS_DIR, loadPrompt } from "./prompts.js";

export const VOICE_AGENT_PROMPT_VERSION = "voice-agent.v1";

/**
 * Builds the static system prompt once at startup. Clinic facts come from the database, not the
 * prompt file, so the prompt never drifts from what get_clinic_info returns.
 */
export async function loadVoiceAgentPrompt(
  repo: ClinicRepository,
  promptsDir: string = DEFAULT_PROMPTS_DIR,
): Promise<string> {
  const template = await loadPrompt(VOICE_AGENT_PROMPT_VERSION, promptsDir);
  const sites = await repo.listSites();
  const facts = sites
    .map(
      (s) =>
        `- ${s.name}, ${s.address}. Scans: ${s.modalities.join(" and ")}. Hours: ${speakableHours(s.hours)}. Parking: ${s.parking}`,
    )
    .join("\n");
  return template.replace("{{CLINIC_FACTS}}", facts);
}
