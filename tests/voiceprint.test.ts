import assert from 'node:assert/strict'
import test from 'node:test'
import { TencentVoiceprintClient, validVoiceprintAudio, validVoiceprintId } from '../src/host/tencent-voiceprint.ts'
import { VoiceprintCapture } from '../src/client/voiceprint.ts'

test('Tencent TC3 client signs enroll and verify without exposing the secret key', async () => {
  const requests: Array<{ headers: Headers; body: string }> = []
  const fakeFetch = async (_input: string | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers)
    const body = String(init?.body ?? '')
    requests.push({ headers, body })
    const action = headers.get('x-tc-action')
    const response = action === 'VoicePrintEnroll'
      ? { Response: { Data: { VoicePrintId: 'vp-test-id', SpeakerNick: 'DSH Voice User' }, RequestId: 'r1' } }
      : { Response: { Data: { Decision: 1, Score: '86.5', VoicePrintId: 'vp-test-id' }, RequestId: 'r2' } }
    return new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const client = new TencentVoiceprintClient(fakeFetch, () => Date.UTC(2026, 7, 16, 12, 0, 0))
  const credentials = { secretId: 'AKIDEXAMPLE', secretKey: 'secret-test-value' }
  assert.equal(await client.enroll('AAAA', credentials), 'vp-test-id')
  assert.deepEqual(await client.verify('AAAA', 'vp-test-id', credentials), { decision: true, score: 86.5 })
  assert.equal(requests.length, 2)
  assert.equal(
    requests[0]?.headers.get('authorization'),
    'TC3-HMAC-SHA256 Credential=AKIDEXAMPLE/2026-08-16/asr/tc3_request, SignedHeaders=content-type;host, Signature=9f1fd8206d4e7f3d012bf944751eccb413289715a26d25c2b0fc91c659d536aa',
  )
  for (const request of requests) {
    assert.match(request.headers.get('authorization') ?? '', /^TC3-HMAC-SHA256 Credential=AKIDEXAMPLE\//)
    assert.doesNotMatch(JSON.stringify(request), /secret-test-value/)
    assert.equal(request.headers.get('x-tc-version'), '2019-06-14')
  }
})

test('Tencent client normalizes provider and HTTP failures without leaking credentials', async () => {
  const credentials = { secretId: 'AKIDEXAMPLE', secretKey: 'never-expose-this' }
  const provider = new TencentVoiceprintClient(async () => new Response(JSON.stringify({
    Response: { Error: { Code: 'InvalidParameterValue.NoHumanVoice', Message: 'no human voice' }, RequestId: 'r' },
  }), { status: 200 }), () => Date.UTC(2026, 7, 16, 12))
  await assert.rejects(provider.enroll('AAAA', credentials), error => {
    assert.match(String(error), /InvalidParameterValue\.NoHumanVoice/)
    assert.doesNotMatch(String(error), /never-expose-this/)
    return true
  })

  const http = new TencentVoiceprintClient(async () => new Response('{}', { status: 503 }), () => Date.UTC(2026, 7, 16, 12))
  await assert.rejects(http.enroll('AAAA', credentials), /HTTP 503/)
})

test('voiceprint capture keeps bounded PCM and returns one complete utterance', () => {
  const capture = new VoiceprintCapture()
  capture.push(new Int16Array(8_000).fill(1))
  capture.start('item-1')
  capture.push(new Int16Array(16_000).fill(2))
  capture.stop('item-1')
  const encoded = capture.takeBase64('item-1')
  assert.equal(typeof encoded, 'string')
  assert.equal(Buffer.from(encoded ?? '', 'base64').byteLength, 48_000)
  assert.equal(capture.takeBase64('item-1'), undefined)
})

test('voiceprint capture rejects utterances shorter than one second', () => {
  const capture = new VoiceprintCapture()
  capture.start('short')
  capture.push(new Int16Array(8_000))
  capture.stop('short')
  assert.equal(capture.takeBase64('short'), undefined)
})

test('voiceprint capture caps audio at 30 seconds and ignores a stale cross-item stop', () => {
  const capture = new VoiceprintCapture()
  capture.start('new-item')
  capture.push(new Int16Array(500_000).fill(3))
  capture.stop('old-item')
  assert.equal(capture.takeBase64('old-item'), undefined)
  capture.stop('new-item')
  const encoded = capture.takeBase64('new-item')
  assert.equal(Buffer.from(encoded ?? '', 'base64').byteLength, 960_000)
})

test('voiceprint validators enforce opaque ids and 1-30 second PCM payloads', () => {
  assert.equal(validVoiceprintId('vp_1234-abc'), true)
  assert.equal(validVoiceprintId('../secret'), false)
  assert.equal(validVoiceprintAudio(Buffer.alloc(32_000).toString('base64')), true)
  assert.equal(validVoiceprintAudio(Buffer.alloc(31_998).toString('base64')), false)
  assert.equal(validVoiceprintAudio(Buffer.alloc(960_002).toString('base64')), false)
})
