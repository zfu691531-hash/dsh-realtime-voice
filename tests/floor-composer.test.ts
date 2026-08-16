import assert from 'node:assert/strict'
import test from 'node:test'
import { cleanFloorTopic, composeFloorText, validateFloorCue } from '../src/host/floor-composer.ts'

test('host floor topic redacts credentials urls emails and long tokens', () => {
  const topic = cleanFloorTopic('深圳天气 https://x.test ghp_abcdefghijklmnopqrstuvwxyz me@example.com 0123456789abcdef0123456789abcdef')
  assert.match(topic, /深圳天气/)
  assert.doesNotMatch(topic, /https|ghp_|example|012345/)
})

test('floor output validator fails closed on answers and machine-shaped text', () => {
  assert.equal(validateFloorCue('我陪你再等一小会儿。'), '我陪你再等一小会儿。')
  for (const unsafe of ['答案是晴天。', '{"cue":"稍等"}', 'https://x.test', '```json', '']) {
    assert.equal(validateFloorCue(unsafe), undefined)
  }
})

test('qwen and openai use separate official endpoints and normalize one safe sentence', async () => {
  const original = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    urls.push(String(input))
    const openai = String(input).includes('api.openai.com')
    return new Response(JSON.stringify(openai
      ? { output_text: '我换个角度陪你捋一下。' }
      : { choices: [{ message: { content: '我顺着这件事再想想。' } }] }), { status: 200 })
  }) as typeof fetch
  try {
    const qwen = await composeFloorText({ provider: 'qwen', workspaceId: 'workspace-test', region: 'cn-beijing', model: 'qwen3.5-flash', topic: '深圳天气', stage: 'ack', previousCues: [] }, 'test-key', new AbortController().signal)
    const openai = await composeFloorText({ provider: 'openai', workspaceId: '', region: 'cn-beijing', model: 'gpt-5-mini', topic: '深圳天气', stage: 'ack', previousCues: [] }, 'test-key', new AbortController().signal)
    assert.match(qwen, /想想/)
    assert.match(openai, /捋一下/)
    assert.match(urls[0] ?? '', /workspace-test\.cn-beijing\.maas\.aliyuncs\.com/)
    assert.equal(urls[1], 'https://api.openai.com/v1/responses')
  } finally { globalThis.fetch = original }
})
