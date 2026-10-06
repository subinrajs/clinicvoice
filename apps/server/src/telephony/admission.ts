import type { CallRepository } from "../repositories/callRepository.js";
import type { UsageRepository } from "../repositories/usageRepository.js";

export type AdmissionResult =
  { admitted: true } | { admitted: false; reason: "concurrency" | "rate_limited" | "budget" };

export interface AdmissionPolicy {
  maxConcurrentCalls: number;
  maxCallsPerNumberPerHour: number;
  dailyTokenBudget: number;
  timeZone: string;
}

/**
 * Abuse and cost controls for a public demo number: concurrency cap, per-caller rate limit,
 * and a daily model-token budget. Checked once, when a call connects.
 */
export async function admitCall(
  policy: AdmissionPolicy,
  deps: {
    activeCalls: number;
    fromHash: string | null;
    calls: CallRepository;
    usage: UsageRepository;
  },
): Promise<AdmissionResult> {
  if (deps.activeCalls >= policy.maxConcurrentCalls)
    return { admitted: false, reason: "concurrency" };
  if (deps.fromHash) {
    const recent = await deps.calls.countRecentCallsFrom(
      deps.fromHash,
      new Date(Date.now() - 3_600_000),
    );
    if (recent >= policy.maxCallsPerNumberPerHour)
      return { admitted: false, reason: "rate_limited" };
  }
  if ((await deps.usage.tokensUsedToday(policy.timeZone)) >= policy.dailyTokenBudget) {
    return { admitted: false, reason: "budget" };
  }
  return { admitted: true };
}
