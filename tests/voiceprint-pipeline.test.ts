import assert from 'node:assert/strict'
import test from 'node:test'
import { QwenPipelineConnection } from '../src/client/qwen-pipeline.ts'
import type { VoicePrefs } from '../src/client/prefs.ts'
import type { RealtimeCallbacks } from '../src/client/realtime.ts'
import { VoiceprintCapture } from '../src/client/voiceprint.ts'

interface PipelineInternals {
  voiceprintConfigured: boolean
  voiceprintEnrolled: boolean
  voiceprintCapture: VoiceprintCapture
  voiceprintDispatchTail: Promise<void>
  utteranceBusy: Map<string, boolean>
  handleAsr(raw: unknown): Promise<void>
}

test('first actionable utterance enrolls but never reaches Harness input', async () => {
  const transcripts: string[] = []
  const states: string[] = []
  const { connection, internals, restoreFetch } = fixture({ enrolled: true }, {
    onState: (_state, detail) => { if (detail) states.push(detail) },
    onTranscript: async text => { transcripts.push(text) },
  })
  try {
    await utterance(internals, 'enroll-1', '这是我的声纹录入句子')
    assert.deepEqual(transcripts, [])
    assert.equal(internals.voiceprintEnrolled, true)
    assert.equal(states.some(value => value.includes('声纹录入成功')), true)
  } finally {
    connection.disconnect()
    restoreFetch()
  }
})

test('approved utterance preserves the normal automatic-submit metadata', async () => {
  const received: Array<{ text: string; busy?: boolean; voiceprint?: string }> = []
  const { connection, internals, restoreFetch } = fixture({ approved: true, score: 90 }, {
    onTranscript: async (text, meta) => { received.push({ text, busy: meta?.capturedWhileBusy, voiceprint: meta?.voiceprint }) },
  }, true)
  try {
    await utterance(internals, 'approved-1', '帮我查一下明天天气')
    assert.deepEqual(received, [{ text: '帮我查一下明天天气', busy: false, voiceprint: 'approved' }])
    await internals.handleAsr(JSON.stringify({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'approved-1',
      transcript: '帮我查一下明天天气',
    }))
    await internals.voiceprintDispatchTail
    assert.equal(received.length, 1)
  } finally {
    connection.disconnect()
    restoreFetch()
  }
})

test('rejected or unavailable voiceprint always stages text instead of auto-submitting', async () => {
  for (const scenario of [
    { configured: true, response: { approved: false, score: 72 }, status: 'rejected' },
    { configured: false, response: {}, status: 'unavailable' },
  ]) {
    const received: Array<{ busy?: boolean; voiceprint?: string }> = []
    const { connection, internals, restoreFetch } = fixture(scenario.response, {
      onTranscript: async (_text, meta) => { received.push({ busy: meta?.capturedWhileBusy, voiceprint: meta?.voiceprint }) },
    }, true, scenario.configured)
    try {
      await utterance(internals, `gate-${scenario.status}`, '打开我的日程')
      assert.deepEqual(received, [{ busy: true, voiceprint: scenario.status }])
    } finally {
      connection.disconnect()
      restoreFetch()
    }
  }
})

test('filler transcripts are discarded before any voiceprint provider call', async () => {
  let fetches = 0
  const { connection, internals, restoreFetch } = fixture({ approved: true, score: 99 }, {}, true)
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (...args) => { fetches++; return await previousFetch(...args) }
  try {
    await utterance(internals, 'filler-1', '嗯')
    assert.equal(fetches, 0)
    assert.equal(internals.voiceprintCapture.takeBase64('filler-1'), undefined)
  } finally {
    connection.disconnect()
    globalThis.fetch = previousFetch
    restoreFetch()
  }
})

test('a slow voiceprint request never blocks later ASR lifecycle events', async () => {
  const originalFetch = globalThis.fetch
  let resolveFetch!: () => void
  globalThis.fetch = async () => {
    await new Promise<void>(resolve => { resolveFetch = resolve })
    return new Response(JSON.stringify({ ok: true, approved: true, score: 90 }), { status: 200 })
  }
  const connection = new QwenPipelineConnection(prefs(), { onState() {}, async onToolCall() {}, async onTranscript() {} })
  const internals = connection as unknown as PipelineInternals
  internals.voiceprintConfigured = true
  internals.voiceprintEnrolled = true
  try {
    await internals.handleAsr(JSON.stringify({ type: 'input_audio_buffer.speech_started', item_id: 'slow-1' }))
    internals.voiceprintCapture.push(new Int16Array(16_000))
    await internals.handleAsr(JSON.stringify({ type: 'input_audio_buffer.speech_stopped', item_id: 'slow-1' }))
    await internals.handleAsr(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'slow-1', transcript: '查询天气' }))
    await internals.handleAsr(JSON.stringify({ type: 'input_audio_buffer.speech_started', item_id: 'next-1' }))
    assert.equal(internals.utteranceBusy.has('next-1'), true)
    await new Promise(resolve => setTimeout(resolve, 0))
    resolveFetch()
    await internals.voiceprintDispatchTail
  } finally {
    connection.disconnect()
    globalThis.fetch = originalFetch
  }
})

async function utterance(internals: PipelineInternals, itemId: string, transcript: string): Promise<void> {
  await internals.handleAsr(JSON.stringify({ type: 'input_audio_buffer.speech_started', item_id: itemId }))
  internals.voiceprintCapture.push(new Int16Array(16_000).fill(1000))
  await internals.handleAsr(JSON.stringify({ type: 'input_audio_buffer.speech_stopped', item_id: itemId }))
  await internals.handleAsr(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: itemId, transcript }))
  await internals.voiceprintDispatchTail
}

function fixture(
  responseBody: Record<string, unknown>,
  callbacks: Partial<RealtimeCallbacks>,
  enrolled = false,
  configured = true,
) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, ...responseBody }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
  const connection = new QwenPipelineConnection(prefs(), {
    onState: callbacks.onState ?? (() => {}),
    onToolCall: callbacks.onToolCall ?? (async () => ({})),
    onTranscript: callbacks.onTranscript,
  })
  const internals = connection as unknown as PipelineInternals
  internals.voiceprintConfigured = configured
  internals.voiceprintEnrolled = enrolled
  return { connection, internals, restoreFetch: () => { globalThis.fetch = originalFetch } }
}

function prefs(): VoicePrefs {
  return {
    provider: 'qwen',
    qwenWorkspaceId: 'ws_123',
    qwenRegion: 'cn-beijing',
    qwenModel: 'qwen3.5-omni-plus-realtime',
    qwenVoice: 'Tina',
    qwenAsrModel: 'qwen3-asr-flash-realtime',
    qwenTtsModel: 'qwen3-tts-flash-realtime',
    qwenTtsVoice: 'Chelsie',
    qwenVadThreshold: 0.85,
    qwenSilenceMs: 700,
    qwenMergeMs: 1200,
    floorDelayMs: 800,
    voiceprintEnabled: true,
    voiceprintThreshold: 75,
    openaiModel: 'gpt-realtime-2.1',
    openaiVoice: 'marin',
    instructions: '',
  }
}
