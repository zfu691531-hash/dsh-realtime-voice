import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { apply, isHostDependencies, type HostDependencies } from '../src/index.ts'

function request(body = {}, method = 'POST') {
  const req = Readable.from([JSON.stringify(body)]) as Readable & Record<string, unknown>
  req.method = method
  req.headers = {
    host: '127.0.0.1:52628',
    origin: 'http://127.0.0.1:52628',
    'content-type': 'application/json',
    'sec-fetch-site': 'same-origin',
  }
  req.socket = { remoteAddress: '127.0.0.1' }
  return req
}

function response() {
  const result = { status: 0, headers: {} as Record<string, string>, body: '' }
  return {
    result,
    value: {
      writeHead(status: number, headers: Record<string, string>) { result.status = status; result.headers = headers },
      end(body = '') { result.body = String(body) },
    },
  }
}

function fixture(configured: boolean, initialPrefs: Record<string, unknown> = {}) {
  const routes = new Map<string, (req: never, res: never) => Promise<void> | void>()
  const upgrades = new Map<string, (req: never, socket: never, head: Buffer) => Promise<void> | void>()
  const disposers: Array<() => void> = []
  let exchanged = 0
  let voiceprintEnrolls = 0
  let voiceprintVerifies = 0
  let voiceprintDeletes = 0
  let floorComposes = 0
  let lastFloorInput: unknown
  let storedPrefs: Record<string, unknown> = { voiceprintThreshold: 75, ...initialPrefs }
  let voiceContextProvider: ((context: { agent?: { id: string } }) => string) | undefined
  const dependencies: HostDependencies = {
    exchangeOpenAi: async () => { exchanged++; return 'v=0\r\na=answer\r\n' },
    exchangeQwen: async () => { exchanged++; return 'v=0\r\na=answer\r\n' },
    voiceprintEnroll: async () => { voiceprintEnrolls++; return 'voiceprint-test-id' },
    voiceprintVerify: async () => { voiceprintVerifies++; return { decision: true, score: 88 } },
    voiceprintDelete: async () => { voiceprintDeletes++ },
    composeFloor: async input => { floorComposes++; lastFloorInput = input; return '我换个自然的说法，马上接着聊。' },
  }
  const ctx = {
    credentials: {
      resolve: async () => configured ? { value: 'fake-test-key', source: 'test' } : undefined,
      describe: async () => ({ configured, writable: false }),
    },
    webServer: {
      register(route: { path: string; handler: (req: never, res: never) => Promise<void> | void }) {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
      registerUpgrade(route: { path: string; handler: (req: never, socket: never, head: Buffer) => Promise<void> | void }) {
        upgrades.set(route.path, route.handler)
        return () => upgrades.delete(route.path)
      },
    },
    systemPrompt: {
      context(input: { text: string | ((context: { agent?: { id: string } }) => string) }) {
        voiceContextProvider = typeof input.text === 'function' ? input.text : () => input.text
        return () => { voiceContextProvider = undefined }
      },
    },
    effect(callback: () => void | (() => void)) { const dispose = callback(); if (typeof dispose === 'function') disposers.push(dispose) },
    get(name: string) {
      if (name !== 'settings') return undefined
      return {
        register() {
          return {
            get: () => storedPrefs,
            update: async (patch: Record<string, unknown>) => { storedPrefs = { ...storedPrefs, ...patch } },
          }
        },
        describe: () => [{ ns: 'dsh-realtime-voice', user: storedPrefs }],
      }
    },
    logger: { info() {}, warn() {} },
  }
  apply(ctx as never, dependencies)
  return {
    routes,
    upgrades,
    disposers,
    exchanged: () => exchanged,
    voiceprintCalls: () => ({ enrolls: voiceprintEnrolls, verifies: voiceprintVerifies, deletes: voiceprintDeletes }),
    floorCalls: () => ({ count: floorComposes, input: lastFloorInput }),
    storedPrefs: () => storedPrefs,
    voiceContext: (sessionId: string) => voiceContextProvider?.({ agent: { id: sessionId } }) ?? '',
  }
}

test('host routes dispose cleanly and can be mounted again', () => {
  const one = fixture(false)
  assert.deepEqual([...one.routes.keys()].sort(), [
    '/dsh-realtime-voice/context',
    '/dsh-realtime-voice/floor-compose',
    '/dsh-realtime-voice/prefs',
    '/dsh-realtime-voice/signaling/openai',
    '/dsh-realtime-voice/signaling/qwen',
    '/dsh-realtime-voice/status',
    '/dsh-realtime-voice/voiceprint',
  ])
  assert.deepEqual([...one.upgrades.keys()].sort(), [
    '/dsh-realtime-voice/asr/qwen',
    '/dsh-realtime-voice/tts/qwen',
  ])
  one.disposers.forEach(dispose => dispose())
  assert.equal(one.routes.size, 0)
  assert.equal(one.upgrades.size, 0)
  const two = fixture(false)
  assert.equal(two.routes.size, 7)
  assert.equal(two.upgrades.size, 2)
})

test('dynamic floor route cleans input and returns only validated model speech', async () => {
  const fx = fixture(true, { floorComposerEnabled: true, qwenWorkspaceId: 'workspace-test', qwenFloorModel: 'qwen3.5-flash' })
  const res = response()
  await fx.routes.get('/dsh-realtime-voice/floor-compose')?.(
    request({ provider: 'qwen', task: '查天气 https://example.com sk-abcdefghijklmnopqrstuvwxyz 深圳明天', stage: 'ack', previousCues: [] }) as never,
    res.value as never,
  )
  assert.equal(res.result.status, 200)
  assert.match(res.result.body, /自然的说法/)
  assert.equal(fx.floorCalls().count, 1)
  const serialized = JSON.stringify(fx.floorCalls().input)
  assert.doesNotMatch(serialized, /example\.com|sk-abcdefghijklmnopqrstuvwxyz/)
})

test('dynamic floor route rejects bad stages and missing credentials before provider use', async () => {
  const fx = fixture(false, { floorComposerEnabled: true, qwenWorkspaceId: 'workspace-test' })
  const bad = response()
  await fx.routes.get('/dsh-realtime-voice/floor-compose')?.(
    request({ provider: 'qwen', task: '深圳天气', stage: 'answer', previousCues: [] }) as never,
    bad.value as never,
  )
  assert.equal(bad.result.status, 400)
  const missing = response()
  await fx.routes.get('/dsh-realtime-voice/floor-compose')?.(
    request({ provider: 'qwen', task: '深圳天气', stage: 'ack', previousCues: [] }) as never,
    missing.value as never,
  )
  assert.equal(missing.result.status, 502)
  assert.equal(fx.floorCalls().count, 0)
})

test('voice output contract is session-scoped runtime context, not route-visible prompt text', async () => {
  const fx = fixture(false)
  assert.equal(fx.voiceContext('voice-session'), '')

  const on = response()
  await fx.routes.get('/dsh-realtime-voice/context')?.(
    request({ sessionId: 'voice-session', active: true }, 'PUT') as never,
    on.value as never,
  )
  assert.equal(on.result.status, 200)
  assert.match(fx.voiceContext('voice-session'), /第一自然段/)
  assert.doesNotMatch(fx.voiceContext('voice-session'), /内容严格为 voice-summary/)
  assert.equal(fx.voiceContext('other-session'), '')

  const off = response()
  await fx.routes.get('/dsh-realtime-voice/context')?.(
    request({ sessionId: 'voice-session', active: false }, 'PUT') as never,
    off.value as never,
  )
  assert.equal(off.result.status, 200)
  assert.equal(fx.voiceContext('voice-session'), '')
})

test('voice context endpoint rejects cross-site activation', async () => {
  const fx = fixture(false)
  const req = request({ sessionId: 'voice-session', active: true }, 'PUT')
  ;(req.headers as Record<string, string>)['sec-fetch-site'] = 'cross-site'
  const res = response()
  await fx.routes.get('/dsh-realtime-voice/context')?.(req as never, res.value as never)
  assert.equal(res.result.status, 403)
  assert.equal(fx.voiceContext('voice-session'), '')
})

test('signaling refuses missing credentials without network exchange', async () => {
  const fx = fixture(false)
  const res = response()
  await fx.routes.get('/dsh-realtime-voice/signaling/openai')?.(
    request({ sdp: 'v=0\r\na=offer\r\n' }) as never,
    res.value as never,
  )
  assert.equal(res.result.status, 502)
  assert.match(res.result.body, /OPENAI_API_KEY/)
  assert.equal(fx.exchanged(), 0)
})

test('configured signaling exchanges canned SDP and never returns the key', async () => {
  const fx = fixture(true)
  const res = response()
  await fx.routes.get('/dsh-realtime-voice/signaling/openai')?.(
    request({ sdp: 'v=0\r\na=offer\r\n' }) as never,
    res.value as never,
  )
  assert.equal(res.result.status, 200)
  assert.match(res.result.body, /a=answer/)
  assert.doesNotMatch(res.result.body, /fake-test-key/)
  assert.equal(fx.exchanged(), 1)
})

test('cross-site signaling is rejected before credential resolution', async () => {
  const fx = fixture(true)
  const req = request({ sdp: 'v=0\r\na=offer\r\n' })
  ;(req.headers as Record<string, string>)['sec-fetch-site'] = 'cross-site'
  const res = response()
  await fx.routes.get('/dsh-realtime-voice/signaling/openai')?.(req as never, res.value as never)
  assert.equal(res.result.status, 403)
  assert.equal(fx.exchanged(), 0)
})

test('voiceprint enrollment, verification and deletion keep the opaque id on the host', async () => {
  const fx = fixture(true)
  const audio = Buffer.alloc(32_000).toString('base64')
  const enroll = response()
  await fx.routes.get('/dsh-realtime-voice/voiceprint')?.(
    request({ operation: 'enroll', audio }) as never,
    enroll.value as never,
  )
  assert.equal(enroll.result.status, 200)
  assert.equal(fx.storedPrefs().voiceprintId, 'voiceprint-test-id')
  assert.doesNotMatch(enroll.result.body, /voiceprint-test-id/)

  const status = response()
  await fx.routes.get('/dsh-realtime-voice/status')?.(request({}, 'GET') as never, status.value as never)
  assert.equal(status.result.status, 200)
  assert.equal(JSON.parse(status.result.body).voiceprint.enrolled, true)
  assert.doesNotMatch(status.result.body, /voiceprint-test-id/)

  const prefs = response()
  await fx.routes.get('/dsh-realtime-voice/prefs')?.(request({}, 'GET') as never, prefs.value as never)
  assert.equal(prefs.result.status, 200)
  assert.doesNotMatch(prefs.result.body, /voiceprint-test-id/)

  const verify = response()
  await fx.routes.get('/dsh-realtime-voice/voiceprint')?.(
    request({ operation: 'verify', audio }) as never,
    verify.value as never,
  )
  assert.equal(verify.result.status, 200)
  assert.deepEqual(JSON.parse(verify.result.body), { ok: true, approved: true, score: 88 })

  const higherThreshold = response()
  await fx.routes.get('/dsh-realtime-voice/prefs')?.(
    request({ voiceprintEnabled: true, voiceprintThreshold: 90 }, 'PUT') as never,
    higherThreshold.value as never,
  )
  assert.equal(higherThreshold.result.status, 200)
  const belowThreshold = response()
  await fx.routes.get('/dsh-realtime-voice/voiceprint')?.(
    request({ operation: 'verify', audio }) as never,
    belowThreshold.value as never,
  )
  assert.deepEqual(JSON.parse(belowThreshold.result.body), { ok: true, approved: false, score: 88 })

  const duplicateEnroll = response()
  await fx.routes.get('/dsh-realtime-voice/voiceprint')?.(
    request({ operation: 'enroll', audio }) as never,
    duplicateEnroll.value as never,
  )
  assert.equal(duplicateEnroll.result.status, 409)

  const remove = response()
  await fx.routes.get('/dsh-realtime-voice/voiceprint')?.(
    request({}, 'DELETE') as never,
    remove.value as never,
  )
  assert.equal(remove.result.status, 200)
  assert.equal(fx.storedPrefs().voiceprintId, '')
  assert.deepEqual(fx.voiceprintCalls(), { enrolls: 1, verifies: 2, deletes: 1 })
})

test('voiceprint fails closed when credentials or sufficient audio are missing', async () => {
  const missing = fixture(false)
  const missingResponse = response()
  await missing.routes.get('/dsh-realtime-voice/voiceprint')?.(
    request({ operation: 'enroll', audio: Buffer.alloc(32_000).toString('base64') }) as never,
    missingResponse.value as never,
  )
  assert.equal(missingResponse.result.status, 502)

  const short = fixture(true)
  const shortResponse = response()
  await short.routes.get('/dsh-realtime-voice/voiceprint')?.(
    request({ operation: 'enroll', audio: Buffer.alloc(4_000).toString('base64') }) as never,
    shortResponse.value as never,
  )
  assert.equal(shortResponse.result.status, 400)
  assert.deepEqual(short.voiceprintCalls(), { enrolls: 0, verifies: 0, deletes: 0 })

  const invalid = fixture(true)
  const invalidResponse = response()
  await invalid.routes.get('/dsh-realtime-voice/voiceprint')?.(
    request({ operation: 'enroll', audio: '!'.repeat(50_000) }) as never,
    invalidResponse.value as never,
  )
  assert.equal(invalidResponse.result.status, 400)

  const oversized = fixture(true)
  const oversizedResponse = response()
  await oversized.routes.get('/dsh-realtime-voice/voiceprint')?.(
    request({ operation: 'enroll', audio: 'A'.repeat(1_400_001) }) as never,
    oversizedResponse.value as never,
  )
  assert.equal(oversizedResponse.result.status, 413)

  const missingDelete = fixture(false, { voiceprintId: 'vp-local-id' })
  const missingDeleteResponse = response()
  await missingDelete.routes.get('/dsh-realtime-voice/voiceprint')?.(
    request({}, 'DELETE') as never,
    missingDeleteResponse.value as never,
  )
  assert.equal(missingDeleteResponse.result.status, 502)
  assert.equal(missingDelete.storedPrefs().voiceprintId, 'vp-local-id')
})

test('cordis install shape: config objects do not masquerade as host dependencies', () => {
  // cordis calls apply(ctx, config); the installed `config: {}` must not be
  // mistaken for the optional test-injection object.
  assert.equal(isHostDependencies({}), false)
  assert.equal(isHostDependencies(undefined), false)
  assert.equal(isHostDependencies(null), false)
  assert.equal(isHostDependencies({ exchangeOpenAi: async () => '' }), false)
  assert.equal(isHostDependencies({
    exchangeOpenAi: async () => '',
    exchangeQwen: async () => '',
    voiceprintEnroll: async () => '',
    voiceprintVerify: async () => ({ decision: false, score: 0 }),
    voiceprintDelete: async () => {},
    composeFloor: async () => '我先看看。',
  } satisfies HostDependencies), true)
})
