# DSH–Codex Collaboration Memory

Keep this ledger operational, evidence-based, and free of sensitive data. Do not archive raw conversations here.

## Active lessons

### M-001 — Use DSH trace semantics, not a second answer model, for speech-floor progress

- Type: division-of-labor
- Direction: mutual
- Scope: realtime voice floor management with DSH collaboration bridge 0.1.4 and Harness 0.1.0-rc.x
- Evidence: DSH task `session-284d8c38-b90e-44fe-857d-1f13fd07ae82` independently reviewed the trace-aware floor manager, found one privacy gap, and returned PASS after redaction and tests were added.
- Confidence: high
- First observed: 2026-08-16
- Last validated: 2026-08-16
- Invalidate when: Harness publishes a versioned ephemeral voice/progress event or changes turn/tool/retry event semantics.
- Application: Keep Harness as the only answer writer; let Codex implement local, bounded, task-aware cues from public lifecycle signals and ask DSH to challenge event-contract and privacy assumptions.

### M-002 — Gate auto-submit only after ASR actionability, without blocking ASR events

- Type: failure-pattern
- Direction: DSH about Codex
- Scope: optional per-utterance cloud voiceprint checks in the Qwen browser PCM pipeline
- Evidence: DSH task `session-c64a4b6f-51dc-4388-ab52-0b71ce2678b5` found that checking every `speech_stopped` item leaked quota and blocked the serialized ASR event tail; moving checks after actionable `completed` events into an independent bounded-memory dispatch path resolved the finding and received PASS.
- Confidence: high
- First observed: 2026-08-16
- Last validated: 2026-08-16
- Invalidate when: the ASR provider supplies a native authenticated-speaker event or changes `speech_started`/`speech_stopped`/`completed` ordering guarantees.
- Application: Buffer bounded PCM locally, discard all ignored/filler/echo paths, start remote verification only for actionable finals, and guard stale results with a connection epoch.

## Candidate observations

## Pending verification

## Retired lessons
