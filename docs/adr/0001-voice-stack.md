# ADR 0001: Port the existing ConversationRelay loop instead of building a new voice stack

- Status: accepted (LLM provider changed to OpenAI in [ADR 0004](0004-openai-as-llm-provider.md))
- Date: 2026-10-05

## Context

The plan left open whether to reuse the existing receptionist voice stack (EcommVoiceAgent) or rebuild on Twilio ConversationRelay. EcommVoiceAgent already _is_ ConversationRelay plus a streaming Claude tool loop, so comparing their latency would mean comparing a transport with itself.

## Decision

Port its relay handler, message types, TwiML builder and simulator into `apps/server`, and rebuild the parts that don't fit a healthcare agent: Zod-defined tools with guards, Postgres instead of JSON fixtures, Fastify instead of Express, sentence-level output filtering, and per-turn latency capture.

## Consequences

Day 2 starts from a known-working voice loop. Speech-to-text, text-to-speech and barge-in stay Twilio's responsibility; the server only exchanges text.
