# Security Policy

## Supported versions

Security fixes are applied to the latest tagged release. Please upgrade before reporting an issue that is already fixed on `main`.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository. Do not open a public issue containing API keys, Workspace IDs, session transcripts, local Harness URLs, or credential files.

Include the affected version, provider, reproduction steps, impact, and a minimal redacted trace. We will acknowledge a complete report as soon as practical and coordinate disclosure after a fix is available.

## Security boundaries

- Provider keys are resolved only by the Harness Host credential service and must never enter browser storage, plugin settings, logs, screenshots, or bug reports.
- HTTP and WebSocket bridges accept loopback same-origin requests only; provider region and endpoint selection are allowlisted.
- ASR text is submitted to the active Harness session. TTS receives only the first visible answer paragraph, never reasoning blocks or tool payloads.
- The plugin does not bypass provider geography, account policy, or user consent requirements.
