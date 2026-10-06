# ADR 0003: Derive conversation state from session facts; keep the prompt and tool list static

- Status: accepted (caching mechanics amended by [ADR 0004](0004-openai-as-llm-provider.md))
- Date: 2026-10-05

## Context

The plan describes an 8-state machine and a system prompt regenerated every turn with the allowed tools. A stored state can drift from what the guards check, and changing the prompt or tool list every turn defeats prompt caching. The model's first token is already the largest slice of the latency budget.

## Decision

- State is a pure function of session facts (`verified`, `lockedOut`, `pendingAction`, `confirmed`, `escalated`). It is shown to the model and the dashboard as a label, and `executeTool` enforces it.
- The system prompt and full tool list are byte-identical on every request, each with a cache breakpoint. The current state, allowed tools and confirmation outcome go in a small second system block after the breakpoint.
- A tool that isn't allowed in the current state returns `TOOL_NOT_ALLOWED_IN_STATE`; it is not removed from the list.

## Consequences

The cached prefix holds across the call, which a unit test asserts. Prompt injection can't widen what the model can do, because allowed tools are enforced outside it.
