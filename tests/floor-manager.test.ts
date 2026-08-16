import assert from 'node:assert/strict'
import test from 'node:test'
import { composeFloorCue, FloorManager, floorAcknowledgement } from '../src/client/floor-manager.ts'

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

test('fast visible result cancels the floor cue', async () => {
  const spoken: string[] = []
  const floor = new FloorManager(20, text => spoken.push(text))
  floor.start('查一下天气')
  floor.resultAvailable()
  await delay(35)
  assert.deepEqual(spoken, [])
})

test('slow result emits a task-aware non-committal cue', async () => {
  const spoken: string[] = []
  const floor = new FloorManager(15, text => spoken.push(text), { longWaitMs: 100 })
  floor.start('分析一下怎么练直角肩')
  await delay(35)
  floor.resultAvailable()
  await delay(20)
  assert.equal(spoken.length, 1)
  assert.match(spoken[0] ?? '', /直角肩|重点|理一理/)
})

test('dispose cancels an unsent cue', async () => {
  const spoken: string[] = []
  const floor = new FloorManager(15, text => spoken.push(text))
  floor.start('写一份计划')
  floor.dispose()
  await delay(30)
  assert.deepEqual(spoken, [])
})

test('cue composition is contextual, varied and never claims a result', () => {
  const weather = floorAcknowledgement('查一下深圳天气')
  const comparison = floorAcknowledgement('比较这两个方案')
  const repair = floorAcknowledgement('修一下这个插件')
  assert.match(weather, /深圳天气/)
  assert.match(comparison, /两个方案/)
  assert.match(repair, /这个插件/)
  assert.doesNotMatch([weather, comparison, repair].join(''), /已经查到|已经完成|答案是/)
  assert.equal(floorAcknowledgement('查一下深圳天气'), weather)
})

test('a verified tool stage gets a later contextual cue and result cancels the long wait', async () => {
  const spoken: string[] = []
  const floor = new FloorManager(5, text => spoken.push(text), { progressDelayMs: 8, longWaitMs: 12 })
  floor.start('查一下深圳明天天气')
  await delay(7)
  floor.reset('tool')
  await delay(10)
  floor.resultAvailable()
  await delay(18)
  assert.equal(spoken.length, 2)
  assert.match(spoken[0] ?? '', /深圳明天天气/)
  assert.match(spoken[1] ?? '', /深圳明天天气|实时|数据/)
})

test('a long wait varies wording and obeys the per-turn cue cap', async () => {
  const spoken: string[] = []
  const floor = new FloorManager(3, text => spoken.push(text), { longWaitMs: 5, maxCues: 3 })
  floor.start('查一下杭州周末天气')
  await delay(28)
  assert.equal(spoken.length, 3)
  assert.equal(new Set(spoken).size, 3)
  assert.equal(spoken.every(cue => cue.includes('杭州周末天气') || cue.includes('还没完全出来')), true)
  floor.dispose()
})

test('sensitive-looking material is never echoed into a cue topic', () => {
  const secrets = [
    'https://example.com/?token=secret',
    'sk-abcdef123456',
    'ghp_abcdefghijklmnopqrstuvwxyz123456',
    'AKIAIOSFODNN7EXAMPLE',
    'Bearer abcdefghijklmnopqrstuvwxyz',
    'me@example.com',
    '0123456789abcdef0123456789abcdef',
  ]
  for (const secret of secrets) {
    const cue = composeFloorCue({ task: `查一下 ${secret}`, stage: 'ack', ordinal: 0, previousCues: [] })
    assert.equal(cue.includes(secret), false)
  }
})

test('retry wording is truthful, contextual and distinct from the first cue', async () => {
  const spoken: string[] = []
  const floor = new FloorManager(3, text => spoken.push(text), { progressDelayMs: 4, longWaitMs: 100 })
  floor.start('分析一下直角肩训练计划')
  await delay(5)
  floor.reset('retry')
  await delay(7)
  floor.resultAvailable()
  assert.equal(spoken.length, 2)
  assert.notEqual(spoken[0], spoken[1])
  assert.match(spoken[1] ?? '', /重试|重新/)
  assert.doesNotMatch(spoken[1] ?? '', /已经完成|结果是/)
})
