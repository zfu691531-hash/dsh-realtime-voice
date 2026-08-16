# Example configuration

Configure the plugin from **Harness → Settings → Plugins → Realtime Voice (Qwen / GPT)**. Values below are examples, not credentials.

## Qwen primary route

| Setting | Example |
|---|---|
| Provider | `qwen` |
| Workspace ID | `ws-your-workspace-id` |
| Region | `cn-beijing` |
| ASR model | `qwen3-asr-flash-realtime` |
| TTS model | `qwen3-tts-flash-realtime` |
| TTS voice | `Chelsie` |
| Human voice threshold | `0.85` |
| Endpoint silence | `700 ms` |
| Segment merge window | `1200 ms` |
| Natural floor delay | `800 ms` |

Provide `DASHSCOPE_API_KEY` through the Harness credential system. Do not paste the key into plugin settings.

## OpenAI route

| Setting | Example |
|---|---|
| Provider | `openai` |
| Model | `gpt-realtime-2.1` |
| Voice | `marin` |
| Natural floor delay | `800 ms` |

Provide `OPENAI_API_KEY` through the Harness credential system. Provider availability and use must comply with the account and regional policy.

## Optional Tencent voiceprint soft gate (Qwen pipeline only)

Provide both `TENCENT_SECRET_ID` and `TENCENT_SECRET_KEY` through the Harness credential system, then enable “本人声纹软门控” in the plugin settings and restart realtime voice. The first utterance with at least one second of effective speech is used only for enrollment; repeat the intended command after the UI reports success.

Subsequent utterances are verified before automatic submission. A rejected utterance, credential error, timeout, or too-short sample remains in the native Harness composer for manual review and sending. The plugin stores only the opaque VoicePrintId on the Host. Use “删除声纹” in settings to remove the upstream enrollment and the local identifier.

This feature reduces accidental activation by other speakers. It does not establish identity, resist replay/deepfake attacks, or authorize sensitive actions.

## Doctor

```bash
dsh plugin --profile web list
```

Confirm that `dsh-realtime-voice` appears at the expected version. In the browser page already opened by Harness, the same-origin status endpoint should report whether each credential reference is configured:

```js
await fetch('/dsh-realtime-voice/status').then(response => response.json())
```

For source checkouts, run `npm run check`. If the microphone button reports the Desktop shell limitation, allow the plugin to open the same Harness URL in Chrome or Edge and grant microphone permission there.
