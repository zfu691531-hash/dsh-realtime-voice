# Realtime Voice Architecture Package

This document is the handoff contract for the wider DSH plugin composition.

## Repository and release identity

- Repository: <https://github.com/zfu691531-hash/dsh-realtime-voice>
- Default branch: `main`
- Development branch: `agent/natural-floor-manager`
- Release line: `0.9.x`
- Baseline commit before 0.9: `6213fcde3d946ecdc380376d3e42f909815f81ed`

The exact released commit is recorded by the immutable Git tag and GitHub Release. Do not duplicate this repository or rewrite its history.

## Responsibility and non-goals

The plugin owns microphone capture, endpointing, ASR transport, native Harness input submission, trace observation, turn/floor coordination, first-paragraph extraction, TTS transport, playback, and guarded barge-in.

It does not own reasoning, memory, web/app tools, business actions, cross-agent collaboration, gesture recognition, or a second conversational model. Harness remains the only reasoning and tool scheduler and the only writer of official conversation history.

## Runtime chain

```text
Microphone → Qwen streaming ASR → native Harness composer/session
           → Harness reasoning + installed plugins/tools
           → assistant text-delta first paragraph → Qwen streaming TTS → speaker
```

The optional OpenAI route uses the provider Realtime transport, but its mandatory delegation tool still routes task reasoning through Harness. The deterministic Qwen ASR → Harness → Qwen TTS route is the primary compatibility baseline.

## Audio, preemption, and trace contract

- ASR finals merge across the configured continuation window; idle/empty composer input auto-submits, while speech captured during Harness/TTS appends to the native draft for explicit send or clear.
- A single `TurnCoordinator` and single-writer TTS queue reject stale generations.
- Floor timing starts only after the trace confirms a real `user/message` with `source.kind === 'user'`.
- `assistant/chunk.text-delta` is visible answer text; `reasoning-delta` is ignored.
- `tool-call-delta`, `block-start(tool-call)`, and `tool/call` invalidate any streamed tool preamble while preserving simple-answer streaming.
- `llm/retry` and `llm/retry-started` invalidate queued/in-flight speech. Qwen `speechEpoch` also closes the TTS-ready race.
- `turn/end(completed)` finishes playback; aborted/interrupted/blocked/error/max-tokens paths cancel or fail without inventing an answer.
- Only explicit cancel phrases cancel an active Harness task. General barge-in stages text in the native composer.

## Data and permission boundary

- Browser: microphone PCM, ephemeral provider audio, transcript drafts, non-secret preferences.
- Harness Host: credential resolution, same-origin signaling/WebSocket proxy, active voice-context TTL.
- Provider: audio/text required by the selected ASR or TTS request.
- Harness session log: user transcript and Harness answer/tool events; local floor cues are never persisted.
- Required permissions: microphone in an external browser for Desktop rc.5, loopback network access, and the chosen provider credential. No filesystem, app-control, memory, gesture, or MCP permission is requested by this plugin.

## Composition dependencies

| Capability | Runtime dependency | Contract |
|---|---:|---|
| General communication/app control | No | Installed Harness tools receive the native user turn; voice never calls them directly. |
| Memory | No | Memory plugins read/write through the same Harness turn and history. Voice stores no independent long-term memory. |
| Gesture control | No | A gesture plugin may trigger native UI actions or voice start/stop, but must not write this plugin's private state. |
| Collaboration Skill/DSH agents | No | Collaboration remains a Harness/Codex workflow; voice observes the resulting session trace only. |
| MCP | No | This is a native DSH Host+Client bundle, not an MCP server. MCP tools remain independently installable. |

## Verified commands

```bash
npm install --ignore-scripts
npm run dev:link-dsh
npm run check
npm pack --json
dsh plugin --profile web list
```

`npm run check` covers typechecking, Host/routes/security, delegation/trace correlation, turn concurrency, floor timing, retry/tool invalidation, TTS sanitation, production build, and client-bundle purity.

## Current risks

- Desktop rc.5 denies renderer microphone permission, so the plugin opens the same loopback session in the default browser.
- Provider latency, quota, model/voice availability, and ASR accuracy remain external dependencies.
- A tool preamble that becomes audible before its later tool-call event cannot be unheard; the output contract prevents such preambles and the trace gate cancels any remaining audio immediately.
- First-paragraph TTS intentionally fails closed for machine-shaped Markdown/JSON/HTML output.
- OpenAI and Qwen provider contracts can change; upgrades require trace and signaling regression tests.
