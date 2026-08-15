import assert from 'node:assert/strict'
import test from 'node:test'
import { extractVoiceSummary, VoiceSummaryStream } from '../src/client/voice-summary.ts'
import { VOICE_OUTPUT_CONTEXT } from '../src/voice-contract.ts'

test('streams complete sentences from the first natural paragraph only', () => {
  const spoken: string[] = []
  const stream = new VoiceSummaryStream(sentence => spoken.push(sentence))
  for (const delta of ['天气晴朗。', '出门不用带伞', '。\n', '\n详细结果不会播。']) stream.push(delta)
  stream.finish('')
  assert.deepEqual(spoken, ['天气晴朗。', '出门不用带伞。'])
})

test('a simple one-paragraph answer is flushed at turn completion', () => {
  const spoken: string[] = []
  const stream = new VoiceSummaryStream(sentence => spoken.push(sentence))
  stream.push('可以，已经处理好了')
  stream.finish('可以，已经处理好了')
  assert.deepEqual(spoken, ['可以，已经处理好了'])
})

test('leading blank lines do not consume the first natural paragraph', () => {
  const spoken: string[] = []
  const stream = new VoiceSummaryStream(sentence => spoken.push(sentence))
  stream.push('\n\n')
  stream.push('这是实际结论。\n\n详细内容。')
  stream.finish('')
  assert.deepEqual(spoken, ['这是实际结论。'])
})

test('legacy complete markers remain supported for in-flight sessions', () => {
  const spoken: string[] = []
  const stream = new VoiceSummaryStream(sentence => spoken.push(sentence))
  for (const delta of ['<!-- voice-', 'summary -->已经成功了。<!--', ' /voice-summary -->详细结果']) stream.push(delta)
  stream.finish('')
  assert.deepEqual(spoken, ['已经成功了。'])
})

test('legacy closing comments split across chunks never leak into TTS', () => {
  const spoken: string[] = []
  const stream = new VoiceSummaryStream(sentence => spoken.push(sentence))
  for (const delta of ['<!-- voice-summary -->结果已经完成。<!--', ' /', 'voice', '-summary', ' -->详细内容']) stream.push(delta)
  stream.finish('')
  assert.deepEqual(spoken, ['结果已经完成。'])
  assert.equal(spoken.some(text => /voice|summary|<!--|-->/i.test(text)), false)
})

test('unsafe machine-shaped first content fails closed', () => {
  assert.equal(extractVoiceSummary('```json\n{"result":true}\n```'), '')
  assert.equal(extractVoiceSummary('<!-- broken comment'), '')
  const spoken: string[] = []
  const stream = new VoiceSummaryStream(sentence => spoken.push(sentence))
  stream.push('{"type":"callout"}')
  stream.finish('{"type":"callout"}')
  assert.deepEqual(spoken, [])
})

test('voice context requires a clean first paragraph and forbids marker output', () => {
  assert.match(VOICE_OUTPUT_CONTEXT, /第一自然段就是可直接播报的口语开场/)
  assert.match(VOICE_OUTPUT_CONTEXT, /第一段后空一行/)
  assert.match(VOICE_OUTPUT_CONTEXT, /不要输出任何 HTML 注释/)
  assert.match(VOICE_OUTPUT_CONTEXT, /最终回答之前不要输出任何可见正文/)
  assert.doesNotMatch(VOICE_OUTPUT_CONTEXT, /内容严格为 voice-summary/)
})
