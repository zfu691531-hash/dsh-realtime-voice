# Realtime Voice Architecture Package

This document is the handoff contract for the wider DSH plugin composition.

## Repository and release identity

- Repository: <https://github.com/zfu691531-hash/dsh-realtime-voice>
- Default branch: `main`
- Release line: `0.12.x`
- Current release candidate: `v0.12.0`
- Released commit: recorded by the immutable `v0.12.0` tag after release publication

The exact released commit is recorded by the immutable Git tag and GitHub Release. Do not duplicate this repository or rewrite its history.

## Responsibility and non-goals

The plugin owns microphone capture, endpointing, ASR transport, optional speaker-interference soft gating, native Harness input submission, trace observation, turn/floor coordination, first-paragraph extraction, TTS transport, playback, and guarded barge-in.

It does not own reasoning, memory, web/app tools, business actions, cross-agent collaboration, gesture recognition, or a second conversational model. Harness remains the only reasoning and tool scheduler and the only writer of official conversation history.

## Runtime chain

```text
Microphone → Qwen streaming ASR → native Harness composer/session
           → Harness reasoning + installed plugins/tools
           → assistant text-delta first paragraph → Qwen streaming TTS → speaker
```

The optional OpenAI route uses the provider Realtime transport, but its mandatory delegation tool still routes task reasoning through Harness. The deterministic Qwen ASR → Harness → Qwen TTS route is the primary compatibility baseline.

## Audio, preemption, and trace contract

- ASR finals merge across the configured continuation window; idle/empty composer input auto-submits, while speech captured during Harness/TTS appends to the native draft under an ASR-only lease. The lease can submit the whole draft only after Harness/TTS returns to listening and the configured dwell expires.
- `speech_started` pauses the dwell before a final transcript exists. Only `speech_stopped` may arm a bounded no-final grace, so a long utterance cannot be cut by a guessed timeout. A merged final resets the dwell; keyboard edit/paste/clear/manual submit, stale draft/connection, voiceprint failure, explicit cancellation, or sensitive-action wording revokes it.
- A single `TurnCoordinator` and single-writer TTS queue reject stale generations.
- Floor timing starts only after the trace confirms a real `user/message` with `source.kind === 'user'`.
- `assistant/chunk.text-delta` is visible answer text; `reasoning-delta` is ignored.
- `tool-call-delta`, `block-start(tool-call)`, and `tool/call` invalidate any streamed tool preamble while preserving simple-answer streaming.
- The floor manager dynamically composes bounded local cues from a sanitized task topic, intent, tool/retry stage, and per-turn deduplication. These cues share the result TTS queue and never become Harness messages.
- `llm/retry` and `llm/retry-started` invalidate queued/in-flight speech. Qwen `speechEpoch` also closes the TTS-ready race.
- `turn/end(completed)` finishes playback; aborted/interrupted/blocked/error/max-tokens paths cancel or fail without inventing an answer.
- Only explicit cancel phrases cancel an active Harness task. General barge-in stages text in the native composer.

## Data and permission boundary

- Browser: microphone PCM, a bounded in-memory voiceprint utterance buffer when explicitly enabled, ephemeral provider audio, transcript drafts, non-secret preferences.
- Harness Host: credential resolution, same-origin signaling/WebSocket proxy, active voice-context TTL, and an optional opaque Tencent VoicePrintId. The ID is not returned to the browser.
- Provider: audio/text required by the selected ASR or TTS request. When voiceprint is enabled, the current 16kHz PCM utterance is also sent to Tencent Cloud for enrollment or verification; raw audio is not persisted by the plugin.
- Harness session log: user transcript and Harness answer/tool events; local floor cues are never persisted.
- Required permissions: microphone in an external browser for Desktop rc.5, loopback network access, and the chosen provider credential. No filesystem, app-control, memory, gesture, or MCP permission is requested by this plugin.
- Voiceprint is a fail-closed auto-submit signal, not authentication: rejected, short, timed-out, or unavailable checks preserve text in the composer for manual sending and never authorize sensitive work.

## Composition dependencies

| Capability | Runtime dependency | Contract |
|---|---:|---|
| General communication/app control | No | Installed Harness tools receive the native user turn; voice never calls them directly. |
| Memory | No | Memory plugins read/write through the same Harness turn and history. Voice stores no independent long-term memory. |
| Gesture control | No | Gesture and voice are peer local-I/O plugins. Neither may call the other's private runtime; multimodal orchestration belongs to a versioned public DSH capability/event layer. |
| Collaboration Skill/DSH agents | No | Collaboration remains a Harness/Codex workflow; voice observes the resulting session trace only. |
| MCP | No | This is a native DSH Host+Client bundle, not an MCP server. MCP tools remain independently installable. |

## Peer I/O baseline: dsh-gesture-mouse v0.1.0

The accepted gesture peer baseline is [dsh-gesture-mouse](https://github.com/zfu691531-hash/dsh-gesture-mouse) at commit `47cc7985b25d340740af9887259c32f4fc6b9b16`, tag `v0.1.0`.

- Its public DSH tools are `gesture_status`, `gesture_start`, `gesture_stop`, and `gesture_test_trigger`.
- Its Swift Helper reports only `hello`, `state`, `stats`, `error`, and `trigger`; a `trigger` contains only `gestureId`, `confidence`, and `timestamp`.
- Images and landmarks do not leave the Swift Helper. `autoStart` defaults to `false`; Camera and Accessibility are its minimum permissions.
- In v0.1.0, external actions are reported only as `planned`, `accepted`, or `ignored`; the gesture plugin does not execute them.
- Voice must not depend on the gesture plugin's IPC, PID, socket/token, Swift state machine, or internal file layout. Gesture must likewise not depend on voice internals.
- Any future integration must use a versioned public DSH capability/event adapter owned by the Host or public capability layer. Multimodal orchestration must not be implemented inside either I/O plugin.
- Gesture confidence is only a sensor signal. It is not identity, authorization, or permission to execute an action.

Real-device Camera/TCC behavior, false-trigger rate, latency, dark/occluded conditions, and formal signing are not yet accepted for the gesture peer. Neither this architecture package nor the voice plugin claims that gesture v0.1.0 is production-ready.

## Verified commands

```bash
npm install --ignore-scripts
npm run dev:link-dsh
npm run check
npm pack --json
dsh plugin --profile web list
```

`npm run check` covers typechecking, Host/routes/security, delegation/trace correlation, turn concurrency, guarded draft dwell/auto-submit, floor timing, retry/tool invalidation, TTS sanitation, production build, and client-bundle purity.

## Current risks

- Desktop rc.5 denies renderer microphone permission, so the plugin opens the same loopback session in the default browser.
- Provider latency, quota, model/voice availability, and ASR accuracy remain external dependencies.
- Optional voiceprint verification adds one provider request per completed utterance, can add latency, and cannot resist replay, synthesis, or targeted impersonation.
- The no-voiceprint auto-send opt-in is intended only for a trusted single-user acoustic environment; background speech can still become text, so sensitive commands remain manual and downstream tools must keep their own confirmation policies.
- A tool preamble that becomes audible before its later tool-call event cannot be unheard; the output contract prevents such preambles and the trace gate cancels any remaining audio immediately.
- First-paragraph TTS intentionally fails closed for machine-shaped Markdown/JSON/HTML output.
- OpenAI and Qwen provider contracts can change; upgrades require trace and signaling regression tests.
