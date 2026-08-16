const DEFAULT_ACK = '嗯，我认真想一下。'

export type FloorResetReason = 'tool' | 'retry'
export type FloorStage = 'ack' | FloorResetReason | 'long-wait'

export interface FloorTimings {
  progressDelayMs?: number
  longWaitMs?: number
  maxCues?: number
}

/**
 * A latency race, not a second answering agent. Harness remains the only
 * reasoning writer. The manager gets lifecycle signals from the Harness turn
 * and emits short, task-aware speech locally; cues never enter prompt/history.
 */
export class FloorManager {
  private timer?: ReturnType<typeof setTimeout>
  private resultStarted = false
  private disposed = false
  private task = ''
  private cueCount = 0
  private previousCues: string[] = []
  private readonly progressDelayMs: number
  private readonly longWaitMs: number
  private readonly maxCues: number

  constructor(
    private readonly delayMs: number,
    private readonly emit: (text: string) => void,
    timings: FloorTimings = {},
  ) {
    this.progressDelayMs = timings.progressDelayMs ?? 3_500
    this.longWaitMs = timings.longWaitMs ?? 7_000
    this.maxCues = timings.maxCues ?? 3
  }

  start(task = ''): void {
    this.cancelTimer()
    this.task = task
    this.cueCount = 0
    this.previousCues = []
    this.resultStarted = false
    this.disposed = false
    this.schedule('ack', this.delayMs)
  }

  /** A visible final-answer delta owns the floor immediately. */
  resultAvailable(): void {
    this.resultStarted = true
    this.cancelTimer()
  }

  /**
   * A tool call or retry invalidates any earlier visible preamble. Start a new
   * verified waiting stage, but do not claim a result or expose tool payloads.
   */
  reset(reason: FloorResetReason): void {
    if (this.disposed) return
    this.resultStarted = false
    this.cancelTimer()
    this.schedule(reason, this.progressDelayMs)
  }

  dispose(): void {
    this.disposed = true
    this.cancelTimer()
  }

  private schedule(stage: FloorStage, delayMs: number): void {
    if (this.disposed || this.resultStarted || this.cueCount >= this.maxCues) return
    this.cancelTimer()
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (this.disposed || this.resultStarted || this.cueCount >= this.maxCues) return
      const cue = composeFloorCue({
        task: this.task,
        stage,
        ordinal: this.cueCount,
        previousCues: this.previousCues,
      })
      this.previousCues.push(cue)
      this.cueCount++
      this.emit(cue)
      if (!this.disposed && !this.resultStarted && this.cueCount < this.maxCues) {
        this.schedule('long-wait', this.longWaitMs)
      }
    }, Math.max(0, delayMs))
  }

  private cancelTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }
}

interface CueContext {
  task: string
  stage: FloorStage
  ordinal: number
  previousCues: string[]
}

type Intent = 'lookup' | 'compare' | 'action' | 'analysis' | 'generic'

/**
 * Compose instead of selecting one fixed sentence. The task contributes a
 * short safe topic, lifecycle contributes the truthful verb, and a stable hash
 * varies syntax without random test/runtime behaviour.
 */
export function composeFloorCue(context: CueContext): string {
  const intent = classifyIntent(context.task)
  const topic = extractTopic(context.task)
  const candidates = cueCandidates(context.stage, intent, topic)
  const seed = stableHash(`${context.task}\u0000${context.stage}\u0000${context.ordinal}`)
  for (let offset = 0; offset < candidates.length; offset++) {
    const cue = candidates[(seed + offset) % candidates.length] ?? DEFAULT_ACK
    if (!context.previousCues.includes(cue)) return cue
  }
  return context.stage === 'long-wait' ? '这一步比平时慢一点，结果一到我就接着说。' : DEFAULT_ACK
}

/** Kept as the public one-shot helper for older callers and tests. */
export function floorAcknowledgement(task: string): string {
  return composeFloorCue({ task, stage: 'ack', ordinal: 0, previousCues: [] })
}

function cueCandidates(stage: FloorStage, intent: Intent, topic: string): string[] {
  const subject = topic === '' ? '你问的这件事' : topic
  if (stage === 'tool') {
    if (intent === 'lookup') return [
      `我还在查${subject}，等它把最新信息返回。`,
      `${subject}这边正在取数据，我继续盯着。`,
      `我再等一下${subject}的实时结果，出来就接着说。`,
    ]
    return [
      `这一步正在调用工具处理${subject}，我继续看着。`,
      `${subject}还在处理，结果一到我马上接上。`,
      `我正在等${subject}这一步返回，很快继续。`,
    ]
  }
  if (stage === 'retry') return [
    `刚才${subject}那一步在重试，我继续看着。`,
    `${subject}这边重新跑了一次，稍等我接着说。`,
    `这一步没丢，正在重新处理${subject}。`,
  ]
  if (stage === 'long-wait') return [
    `${subject}比平时慢一点，我还在这儿盯着。`,
    `还差${subject}这一步，它一返回我就马上接上。`,
    `还没完全出来，我继续等${subject}的结果。`,
    `这次等得稍微久一点，${subject}出来我就继续。`,
  ]
  if (intent === 'lookup') return [
    `好，我先查一下${subject}。`,
    `嗯，${subject}我帮你看看。`,
    `行，我先把${subject}查清楚。`,
    `我看一下${subject}的最新情况。`,
  ]
  if (intent === 'compare') return [
    `好，我先把${subject}理一理。`,
    `${subject}我放在一起帮你对比。`,
    `行，我先看看${subject}的关键差别。`,
  ]
  if (intent === 'action') return [
    `好，${subject}我来处理。`,
    `行，我先处理${subject}。`,
    `收到，我现在看${subject}。`,
  ]
  if (intent === 'analysis') return [
    `嗯，我先把${subject}想清楚。`,
    `好，${subject}我帮你理一下。`,
    `行，我先抓一下${subject}的重点。`,
  ]
  return [DEFAULT_ACK, `好，${subject}我先理一下。`, `嗯，我先看看${subject}。`]
}

function classifyIntent(task: string): Intent {
  const normalized = task.replace(/\s+/g, '')
  if (/(查|搜索|天气|新闻|资料|附近|哪里|几点|价格|最新)/.test(normalized)) return 'lookup'
  if (/(对比|比较|选哪个|哪个好|区别|优缺点)/.test(normalized)) return 'compare'
  if (/(写|改|修|安装|创建|生成|处理|执行|操作|发布|上传)/.test(normalized)) return 'action'
  if (/(计划|规划|分析|为什么|怎么办|怎么练|怎么做|建议|推理)/.test(normalized)) return 'analysis'
  return 'generic'
}

function extractTopic(task: string): string {
  const compact = task
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\b(?:sk|key|token)-[a-z0-9_-]+\b/gi, ' ')
    .replace(/\b(?:gh[pousr]_[a-z0-9]+|github_pat_[a-z0-9_]+|A(?:KI|SI)A[0-9A-Z]{16})\b/gi, ' ')
    .replace(/\bBearer\s+\S+/gi, ' ')
    .replace(/\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S+/gi, ' ')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, ' ')
    .replace(/\b(?:[a-f0-9]{32,}|[a-z0-9+/]{24,}={0,2})\b/gi, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, '')
    .replace(/^(?:请|麻烦|你能不能|能不能|可不可以|帮我|给我|我想|想让你)+/g, '')
    .replace(/^(?:查一下|查查|搜索|查|看看|看一下|分析一下|分析|比较一下|对比一下|处理一下|处理)+/g, '')
    .replace(/[，。！？，.!?;:；："'“”‘’`<>{}[\]()/\\|]+/g, '')
    .slice(0, 18)
  return compact.length >= 2 ? compact : ''
}

function stableHash(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}
