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

## Doctor

```bash
dsh plugin --profile web list
```

Confirm that `dsh-realtime-voice` appears at the expected version. In the browser page already opened by Harness, the same-origin status endpoint should report whether each credential reference is configured:

```js
await fetch('/dsh-realtime-voice/status').then(response => response.json())
```

For source checkouts, run `npm run check`. If the microphone button reports the Desktop shell limitation, allow the plugin to open the same Harness URL in Chrome or Edge and grant microphone permission there.
