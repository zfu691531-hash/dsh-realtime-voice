import assert from 'node:assert/strict'
import test from 'node:test'
import { FloorManager, floorAcknowledgement } from '../src/client/floor-manager.ts'

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

test('fast visible result cancels the floor cue', async () => {
  const spoken: string[] = []
  const floor = new FloorManager(20, text => spoken.push(text))
  floor.start('查一下天气')
  floor.resultAvailable()
  await delay(35)
  assert.deepEqual(spoken, [])
})

test('slow result emits exactly one non-committal cue', async () => {
  const spoken: string[] = []
  const floor = new FloorManager(15, text => spoken.push(text))
  floor.start('分析一下怎么练直角肩')
  await delay(35)
  floor.resultAvailable()
  await delay(20)
  assert.deepEqual(spoken, ['嗯，我认真想一下。'])
})

test('dispose cancels an unsent cue', async () => {
  const spoken: string[] = []
  const floor = new FloorManager(15, text => spoken.push(text))
  floor.start('写一份计划')
  floor.dispose()
  await delay(30)
  assert.deepEqual(spoken, [])
})

test('cue choice is contextual but never claims a result', () => {
  assert.equal(floorAcknowledgement('查一下深圳天气'), '嗯，我先查一下。')
  assert.equal(floorAcknowledgement('比较这两个方案'), '好，我先帮你理一理。')
  assert.equal(floorAcknowledgement('修一下这个插件'), '好，我来处理。')
})
