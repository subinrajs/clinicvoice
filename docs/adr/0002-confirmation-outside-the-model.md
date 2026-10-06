# ADR 0002: Write confirmation is decided by code, not by the model

- Status: accepted
- Date: 2026-10-05

## Context

The plan requires that nothing is booked, cancelled or sent without the caller's spoken "yes". If the model decides that the caller said yes, confirmation is still a prompt-level guarantee.

## Decision

1. The model calls `propose_action(tool, args)`. The server validates the arguments against the target tool's schema and produces the read-back sentence from those arguments with the tool's `describe()`. Model text is never used for the read-back.
2. On the caller's next utterance, `classifyConfirmation()` (a deterministic EN/FR lexicon with hedge detection) runs _before_ the model sees the text. Only a clear yes sets `pendingAction.confirmed`. Anything ambiguous means asking again.
3. The `requireConfirmed` guard runs a write only if the tool name and deep-equal arguments match the confirmed pending action. A confirmation is consumed by one write.

## Consequences

"The model booked something the caller didn't agree to" is impossible by construction, and unit tests cover it. The cost is an occasional extra "yes or no?" when a caller answers loosely; we accept that trade.
