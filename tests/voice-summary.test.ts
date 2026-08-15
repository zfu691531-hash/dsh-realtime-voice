import assert from 'node:assert/strict'
import test from 'node:test'
import { extractVoiceSummary, VoiceSummaryStream } from '../src/client/voice-summary.ts'
import { VOICE_OUTPUT_CONTEXT } from '../src/voice-contract.ts'

test('streams complete summary sentences across arbitrarily split markers', () => {
  const spoken: string[] = []
  const stream = new VoiceSummaryStream(sentence => spoken.push(sentence))
  for (const delta of ['工具前置文字', '<!--voice-', 'summary-->', '天气晴朗。', '出门不用带伞', '。<!--/voice-sum', 'mary-->', '详细结果不会播']) {
    stream.push(delta)
  }
  stream.finish('')
  assert.deepEqual(spoken, ['天气晴朗。', '出门不用带伞。'])
})

test('reasoning and detail outside summary markers are never spoken', () => {
  const spoken: string[] = []
  const stream = new VoiceSummaryStream(sentence => spoken.push(sentence))
  stream.push('私有推理和工具过程。<!--voice-summary-->结论已经完成。<!--/voice-summary-->完整代码与长说明。')
  stream.finish('')
  assert.deepEqual(spoken, ['结论已经完成。'])
})

test('accepts spaced summary comments emitted by Harness', () => {
  const spoken: string[] = []
  const stream = new VoiceSummaryStream(sentence => spoken.push(sentence))
  stream.push('<!-- voice-')
  stream.push('summary -->已经调试成功。<!-- /voice-summary -->详细内容')
  stream.finish('')
  assert.deepEqual(spoken, ['已经调试成功。'])
})

test('holds a spaced closing comment split across streaming chunks', () => {
  const spoken: string[] = []
  const stream = new VoiceSummaryStream(sentence => spoken.push(sentence))
  for (const delta of ['<!-- voice-summary -->结果已经完成。<!--', ' /', 'voice', '-summary', ' -->详细内容']) stream.push(delta)
  stream.finish('')
  assert.deepEqual(spoken, ['结果已经完成。'])
  assert.equal(spoken.some(text => /voice|summary|<!--|-->/i.test(text)), false)
})

test('missing or unclosed summary markers fail closed', () => {
  assert.equal(extractVoiceSummary('第一句正文。第二句正文。'), '')
  assert.equal(extractVoiceSummary('<!-- voice-summary -->没有结束标记。后面可能是详细正文。'), '')
  const spoken: string[] = []
  const stream = new VoiceSummaryStream(sentence => spoken.push(sentence))
  stream.push('<!-- voice-summary -->没有结束标记')
  stream.finish('第一句正文。')
  assert.deepEqual(spoken, [])
})

test('hidden voice context requires summary before detail', () => {
  assert.match(VOICE_OUTPUT_CONTEXT, /内容严格为 voice-summary 的 HTML 注释/)
  assert.match(VOICE_OUTPUT_CONTEXT, /随后输出完整结果/)
})
