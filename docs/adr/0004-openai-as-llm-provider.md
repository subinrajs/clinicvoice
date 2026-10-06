# ADR 0004: Use OpenAI as the LLM provider, behind a vendor-neutral model interface

- Status: accepted
- Date: 2026-10-05
- Amends: ADR 0001 (provider), ADR 0003 (caching mechanics)

## Context

The project plan specified Claude for live turns and for offline work (summaries, implant extraction, grading). The decision now is to run on OpenAI. The safety design (derived state, guards, confirmation outside the model, output filter) never depended on the vendor, and it should stay that way.

## Decision

- Add `src/llm/types.ts`: a neutral `ChatModel` interface with its own message, tool-call and tool-spec types. The session, agent loop and tests depend only on it.
- Implement `OpenAIChatModel` on Chat Completions with streaming. Text deltas feed the sentence buffer, and tool-call fragments are assembled by index. `parallel_tool_calls: false` keeps confirmation and audit ordering simple.
- Models are configured by environment variable:
  - `OPENAI_LIVE_MODEL` defaults to `gpt-5.4-mini`.
  - `OPENAI_LIVE_REASONING_EFFORT` defaults to `none` in `.env.example`, because reasoning tokens are silence on a call.
  - `OPENAI_OFFLINE_MODEL` defaults to `gpt-5.5`.
- Caching: OpenAI caches matching prefixes automatically (no explicit breakpoints). The request is ordered `system → tools → history → per-turn context`, so the stable prefix grows turn by turn. `prompt_cache_key = call:<id>` routes a call's requests together. Cached-token counts are reported per turn in `TurnMetrics`.

## Consequences

- Prompt-cache hits need a prefix of at least 1024 tokens. If the static prompt is shorter, the first turns of a call pay full price, so `cachedInputTokens` should be watched in logs from day 2.
- Malformed tool-argument JSON from the model is passed through as `{}`, so schema validation rejects it and the model is told to retry. It never crashes the turn.
- Changing provider again means adding one adapter. The guards and tests stay as they are.
