import { HarnessBridge, type DelegateResult, type TextResetReason } from './harness-delegate.ts'
import { FloorManager } from './floor-manager.ts'
import { resolveDynamicFloorCue } from './floor-composer.ts'
import { loadPrefs, type VoicePrefs } from './prefs.ts'
import { RealtimeConnection, type RealtimeCallbacks, type TranscriptMeta } from './realtime.ts'
import type { ToolCall } from './protocol.ts'
import { QwenPipelineConnection } from './qwen-pipeline.ts'
import { TurnCoordinator, type TurnPhase } from './turn-coordinator.ts'
import { VoiceSummaryStream } from './voice-summary.ts'

export type VoiceState = 'idle' | 'connecting' | 'listening' | 'speaking' | 'working' | 'error'
export interface VoiceSnapshot { state: VoiceState; detail: string; provider: 'qwen' | 'openai' }
export interface VoiceConnection {
  connect(): Promise<void>
  disconnect(): void
  speak?(text: string): Promise<void>
  waitForSpeechIdle?(): Promise<void>
  cancelSpeech?(): void
  setInputPhase?(phase: TurnPhase): void
}
export type VoiceConnectionFactory = (prefs: VoicePrefs, callbacks: RealtimeCallbacks) => VoiceConnection
export interface VoiceDraftTarget {
  getDraft(): string
  getDraftRev?(): number
  getPhase?(): 'plain' | 'adjudicating' | 'claimed' | 'submitting'
  setDraft(text: string): void
  submit?(): void
}

interface ObservedSpeech {
  harnessTurn: string
  turnId: number
  source: VoiceConnection
  summary: VoiceSummaryStream
  floor: FloorManager
  speechQueue: Promise<void>
  speechCancelled: boolean
  speechError?: unknown
  speechGeneration: number
  visibleTextSeen: boolean
}

interface DraftAutoSendLease {
  source: VoiceConnection
  expectedDraft: string
  expectedDraftRev?: number
  generation: number
}

export class VoiceController {
  private connection?: VoiceConnection
  private snapshot: VoiceSnapshot = { state: 'idle', detail: '', provider: loadPrefs().provider }
  private readonly listeners = new Set<() => void>()
  private taskAbort?: AbortController
  private connectionEpoch = 0
  private transcriptTimer?: ReturnType<typeof setTimeout>
  private transcriptSource?: VoiceConnection
  private transcriptSegments: string[] = []
  private transcriptWasBusy = false
  private transcriptCapturedWhileBusy = false
  private transcriptVoiceprint: TranscriptMeta['voiceprint']
  private draftTarget?: VoiceDraftTarget
  private boundDraft = ''
  private boundDraftRev?: number
  private pluginDraftWritePending = false
  private deferredDraft = ''
  private draftAutoSendLease?: DraftAutoSendLease
  private draftAutoSendTimer?: ReturnType<typeof setTimeout>
  private draftCommitTimer?: ReturnType<typeof setTimeout>
  private draftSpeechResumeTimer?: ReturnType<typeof setTimeout>
  private draftSpeechActive = false
  private draftAutoSendGeneration = 0
  private readonly turns = new TurnCoordinator()
  private composerOnly = false
  private stopObserving?: () => void
  private voiceContextTimer?: ReturnType<typeof setInterval>
  private observedSpeech?: ObservedSpeech
  private nativeSubmitPending = false
  private nativeSubmitTimer?: ReturnType<typeof setTimeout>
  private nativeSubmittedTask = ''

  constructor(
    readonly sessionId: string,
    private readonly bridge: HarnessBridge,
    private readonly createConnection: VoiceConnectionFactory = (prefs, callbacks) => prefs.provider === 'qwen'
      ? new QwenPipelineConnection(prefs, callbacks)
      : new RealtimeConnection(prefs, callbacks),
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): VoiceSnapshot => this.snapshot

  bindDraft(target: VoiceDraftTarget): () => void {
    const current = target.getDraft()
    const currentRev = target.getDraftRev?.()
    // React rebinds this adapter after every composer render. A value equal to
    // boundDraft is our own expected write; a mismatch is a real user edit,
    // paste or clear and revokes the ASR-owned auto-send lease.
    if (current !== this.boundDraft) {
      this.disarmDraftAutoSend('输入框已由你修改；自动发送已取消')
      this.boundDraft = current
      this.boundDraftRev = currentRev
      this.pluginDraftWritePending = false
    } else if (currentRev !== undefined && this.boundDraftRev !== undefined && currentRev !== this.boundDraftRev) {
      if (!this.pluginDraftWritePending) this.disarmDraftAutoSend('输入框已由你修改；自动发送已取消')
      this.boundDraftRev = currentRev
      this.pluginDraftWritePending = false
      if (this.draftAutoSendLease !== undefined) this.draftAutoSendLease.expectedDraftRev = currentRev
    } else if (this.boundDraftRev === undefined) {
      this.boundDraftRev = currentRev
    }
    this.draftTarget = target
    if (this.deferredDraft !== '') {
      this.appendToDraft(this.deferredDraft)
      this.deferredDraft = ''
    }
    return () => { if (this.draftTarget === target) this.draftTarget = undefined }
  }

  async toggle(): Promise<void> {
    if (this.connection !== undefined) return this.stop()
    if (new URLSearchParams(location.search).has('dsh-desktop-platform')) {
      this.setState('error', '桌面壳暂不开放麦克风；正在用默认浏览器打开同一会话')
      window.open(location.href.replace(/([?&])dsh-desktop-platform=[^&]*&?/, '$1').replace(/[?&]$/, ''), '_blank', 'noopener')
      return
    }
    const prefs = loadPrefs()
    this.snapshot = { state: 'connecting', detail: '', provider: prefs.provider }
    this.emit()
    const epoch = ++this.connectionEpoch
    let connection!: VoiceConnection
    connection = this.createConnection(prefs, {
      onState: (state, detail) => {
        if (this.connection !== connection) return
        if (state === 'speaking' && this.turns.phase === 'tts-pending') this.setTurnPhase(this.turns.turnId, 'tts-speaking')
        if (state === 'listening' && this.turns.phase !== 'listening' && this.turns.phase !== 'endpoint-candidate') return
        if (this.taskAbort === undefined) this.setState(state, detail ?? '')
      },
      onToolCall: call => this.handleToolCall(connection, call),
      onSpeechStart: () => this.handleSpeechStart(connection),
      onSpeechEnd: () => this.handleSpeechEnd(connection),
      onTranscript: (text, meta) => this.turns.enqueue(() => this.bufferTranscript(connection, text, meta)),
    })
    this.connection = connection
    try {
      if (prefs.provider === 'qwen') {
        const enabled = this.enableNativeComposer(connection)
        this.composerOnly = typeof enabled === 'boolean' ? enabled : await enabled
      }
      await connection.connect()
    } catch (error) {
      this.disableNativeComposer()
      connection.disconnect()
      if (this.connectionEpoch !== epoch || this.connection !== connection) return
      this.connection = undefined
      this.setState('error', error instanceof Error ? error.message : String(error))
    }
  }

  stop(): void {
    this.connectionEpoch++
    this.turns.invalidate()
    this.disarmDraftAutoSend()
    this.flushBufferedTranscriptToDraft()
    this.taskAbort?.abort()
    this.taskAbort = undefined
    this.clearNativeSubmitPending()
    this.disableNativeComposer()
    this.cancelObservedSpeech()
    const connection = this.connection
    this.connection = undefined
    connection?.disconnect()
    this.setState('idle', '')
  }

  dispose(): void { this.stop(); this.listeners.clear() }

  private async bufferTranscript(source: VoiceConnection, transcript: string, meta: TranscriptMeta = {}): Promise<void> {
    if (this.connection !== source) return
    const segment = transcript.trim()
    if (segment === '') return
    if (this.transcriptSource !== undefined && this.transcriptSource !== source) this.flushBufferedTranscriptToDraft()
    this.transcriptSource = source
    this.transcriptSegments.push(segment)
    const capturedWhileBusy = meta.capturedWhileBusy === true
    const wasBusy = capturedWhileBusy
      || this.hasPendingDraft()
      || this.nativeSubmitPending
      || this.taskAbort !== undefined
      || (this.turns.phase !== 'listening' && this.turns.phase !== 'endpoint-candidate')
    this.transcriptWasBusy ||= wasBusy
    this.transcriptCapturedWhileBusy ||= capturedWhileBusy
    if (meta.voiceprint === 'rejected' || meta.voiceprint === 'unavailable') this.transcriptVoiceprint = meta.voiceprint
    else if (meta.voiceprint === 'approved' && this.transcriptVoiceprint === undefined) this.transcriptVoiceprint = 'approved'
    if (!wasBusy && this.turns.phase === 'listening') this.setTurnPhase(this.turns.turnId, 'endpoint-candidate')
    if (this.transcriptTimer !== undefined) clearTimeout(this.transcriptTimer)
    this.transcriptTimer = setTimeout(() => {
      this.transcriptTimer = undefined
      const wasBusy = this.transcriptWasBusy
      const capturedWhileBusy = this.transcriptCapturedWhileBusy
      const voiceprint = this.transcriptVoiceprint
      const combined = this.takeBufferedTranscript()
      if (combined !== '') void this.turns.enqueue(() => this.composerOnly
        ? wasBusy ? this.stageComposerTranscript(source, combined, { capturedWhileBusy, voiceprint }) : this.submitComposerTranscript(source, combined)
        : wasBusy ? this.handleBusyTranscript(source, combined) : this.handleTranscript(source, combined))
    }, loadPrefs().qwenMergeMs)
  }

  private async handleToolCall(source: VoiceConnection, call: ToolCall): Promise<unknown> {
    if (this.connection !== source) return { ok: false, error: '语音连接已关闭' }
    if (call.name === 'cancel_harness_task') {
      this.disarmDraftAutoSend()
      this.taskAbort?.abort()
      const cancelled = await this.bridge.cancel(this.sessionId)
      if (this.connection === source) {
        this.invalidateCurrentTurn(source)
        this.setState('listening', cancelled ? 'Harness 任务已取消' : '没有正在执行的 Harness 任务')
      }
      return { ok: true, cancelled }
    }
    let task = ''
    try {
      const args = JSON.parse(call.arguments) as { task?: unknown }
      if (typeof args.task === 'string') task = args.task.trim()
    } catch { /* validated below */ }
    if (task === '') return { ok: false, error: 'delegate_to_harness 缺少 task' }
    this.setState('working', task.slice(0, 100))
    const taskAbort = new AbortController()
    this.taskAbort = taskAbort
    const result = await this.bridge.delegate(this.sessionId, task, taskAbort.signal)
    if (this.taskAbort === taskAbort) this.taskAbort = undefined
    if (this.connection === source) this.setState('listening', result.ok ? 'Harness 已完成' : result.error)
    return result
  }

  private async handleTranscript(source: VoiceConnection, transcript: string): Promise<void> {
    if (this.connection !== source) return
    const task = transcript.trim()
    if (task === '') return
    // A background utterance must never kill a Harness turn that is already
    // using tools. Only an explicit spoken cancel command may do that. General
    // barge-in remains available while TTS is speaking, after the Harness turn
    // has completed.
    if (this.taskAbort !== undefined) {
      if (isExplicitCancel(task)) {
        this.disarmDraftAutoSend()
        const active = this.taskAbort
        active.abort()
        const cancelled = await this.bridge.cancel(this.sessionId)
        if (this.taskAbort === active) this.taskAbort = undefined
        if (this.connection === source) {
          this.invalidateCurrentTurn(source)
          this.setState('listening', cancelled ? 'Harness 任务已取消' : '没有正在执行的 Harness 任务')
        }
      } else {
        this.appendToDraft(task)
        this.setState('working', '继续任务：新语音已转成文字；发送后排队处理，也可以直接清空')
      }
      return
    }
    // ASR remains open while Harness/TTS works so genuine barge-in stays
    // possible. Before audio has actually started, however, a late/background
    // final must not preempt the answer that is about to play.
    if (this.turns.phase === 'tts-pending' || this.turns.phase === 'tts-speaking' || this.turns.phase === 'post-playback') {
      this.appendToDraft(task)
      this.setState(this.turns.phase === 'tts-speaking' ? 'speaking' : 'working', '继续任务：新语音已保留在输入框；发送后处理，或直接清空')
      return
    }
    const turnId = this.turns.begin()
    this.setTurnPhase(turnId, 'harness')
    this.setState('working', task.slice(0, 100))
    const taskAbort = new AbortController()
    this.taskAbort = taskAbort
    void this.runHarnessTurn(source, task, turnId, taskAbort).catch(error => {
      if (this.connection !== source || !this.turns.isCurrent(turnId)) return
      this.setTurnPhase(turnId, 'listening')
      this.setState('error', error instanceof Error ? error.message : String(error))
    })
  }

  private async handleBusyTranscript(source: VoiceConnection, transcript: string): Promise<void> {
    if (this.connection !== source) return
    const task = transcript.trim()
    if (task === '') return
    if (this.taskAbort !== undefined && isExplicitCancel(task)) {
      this.disarmDraftAutoSend()
      await this.handleTranscript(source, task)
      return
    }
    this.appendToDraft(task)
    const playback = this.turns.phase === 'tts-speaking' || this.turns.phase === 'post-playback'
    this.setState(playback ? 'speaking' : this.taskAbort !== undefined ? 'working' : 'listening', '继续任务：新语音已保留在输入框；发送后处理，或直接清空')
  }

  private stageComposerTranscript(source: VoiceConnection, transcript: string, meta: TranscriptMeta = {}): void {
    if (this.connection !== source) return
    this.appendToDraft(transcript)
    this.armDraftAutoSend(source, meta)
    if (this.turns.phase === 'endpoint-candidate') this.setTurnPhase(this.turns.turnId, 'listening')
    if (this.turns.phase === 'listening') this.updateDraftAutoSendStatus()
  }

  private submitComposerTranscript(source: VoiceConnection, transcript: string): void {
    if (this.connection !== source) return
    const target = this.draftTarget
    if (target?.submit === undefined) {
      this.stageComposerTranscript(source, transcript)
      return
    }
    this.appendToDraft(transcript)
    this.submitBoundDraft(source)
  }

  private submitBoundDraft(source: VoiceConnection): void {
    if (this.connection !== source) return
    const target = this.draftTarget
    const submittedTask = this.boundDraft.trim()
    if (target?.submit === undefined || submittedTask === '') return
    this.disarmDraftAutoSend()
    this.nativeSubmittedTask = submittedTask
    this.nativeSubmitPending = true
    this.setState('working', '语音已识别，正在交给 Harness')
    queueMicrotask(() => {
      if (this.connection !== source || !this.nativeSubmitPending) return
      try {
        target.submit?.()
        // The native composer clears its draft after submit, but React may not
        // rebind this target until the next render. Drop our shadow copy now so
        // speech captured during that gap cannot resurrect the submitted turn.
        this.boundDraft = ''
        this.boundDraftRev = undefined
        this.pluginDraftWritePending = false
      } catch (error) {
        this.nativeSubmittedTask = ''
        this.clearNativeSubmitPending()
        if (this.turns.phase === 'endpoint-candidate') this.setTurnPhase(this.turns.turnId, 'listening')
        this.setState('error', `自动发送失败，文字已保留在输入框：${error instanceof Error ? error.message : String(error)}`)
        return
      }
      if (!this.nativeSubmitPending) return
      this.nativeSubmitTimer = setTimeout(() => {
        this.nativeSubmitTimer = undefined
        if (!this.nativeSubmitPending || this.connection !== source) return
        this.nativeSubmitPending = false
        this.nativeSubmittedTask = ''
        if (this.turns.phase === 'endpoint-candidate') this.setTurnPhase(this.turns.turnId, 'listening')
        this.setState('error', 'Harness 未确认自动发送；请检查输入框后手动发送')
      }, 10_000)
    })
  }

  private enableNativeComposer(source: VoiceConnection): boolean | Promise<boolean> {
    const bridge = this.bridge as HarnessBridge & Partial<Pick<HarnessBridge, 'observeSession' | 'setVoiceMode'>>
    if (typeof bridge.observeSession !== 'function' || typeof bridge.setVoiceMode !== 'function') return false
    this.stopObserving = bridge.observeSession(this.sessionId, {
      onTurnStart: harnessTurn => this.beginObservedTurn(source, harnessTurn),
      onTextDelta: (harnessTurn, delta) => this.pushObservedDelta(harnessTurn, delta),
      onTextReset: (harnessTurn, reason) => this.resetObservedSpeech(harnessTurn, reason),
      onTurnEnd: (harnessTurn, result) => { void this.finishObservedTurn(harnessTurn, result) },
    })
    return bridge.setVoiceMode(this.sessionId, true).then(() => {
      this.voiceContextTimer = setInterval(() => { void bridge.setVoiceMode?.(this.sessionId, true).catch(() => {}) }, 10 * 60_000)
      return true
    })
  }

  private disableNativeComposer(): void {
    this.disarmDraftAutoSend()
    this.draftSpeechActive = false
    this.stopObserving?.()
    this.stopObserving = undefined
    if (this.voiceContextTimer !== undefined) clearInterval(this.voiceContextTimer)
    this.voiceContextTimer = undefined
    this.clearNativeSubmitPending()
    this.cancelObservedSpeech()
    if (this.composerOnly) void this.bridge.setVoiceMode?.(this.sessionId, false).catch(() => {})
    this.composerOnly = false
    this.nativeSubmittedTask = ''
  }

  private beginObservedTurn(source: VoiceConnection, harnessTurn: string): void {
    if (this.connection !== source || !this.composerOnly) return
    this.disarmDraftAutoSend()
    this.cancelObservedSpeech()
    const submittedTask = this.nativeSubmittedTask
    this.nativeSubmittedTask = ''
    this.clearNativeSubmitPending()
    const turnId = this.turns.begin()
    this.setTurnPhase(turnId, 'harness')
    this.setState('working', '输入已发送，Harness 正在处理')
    const observed = {} as ObservedSpeech
    observed.harnessTurn = harnessTurn
    observed.turnId = turnId
    observed.source = source
    observed.speechQueue = Promise.resolve()
    observed.speechCancelled = false
    observed.speechGeneration = 0
    observed.visibleTextSeen = false
    const enqueueSpeech = (sentence: string) => {
      if (source.speak === undefined || observed.speechCancelled) return
      const generation = observed.speechGeneration
      if (this.connection === source && this.turns.isCurrent(turnId)) this.setTurnPhase(turnId, 'tts-pending')
      observed.speechQueue = observed.speechQueue.then(async () => {
        if (generation !== observed.speechGeneration || observed.speechCancelled || this.connection !== source || !this.turns.isCurrent(turnId)) return
        await source.speak?.(sentence)
      }).catch(error => {
        if (generation !== observed.speechGeneration) return
        observed.speechError = error
        observed.speechCancelled = true
      })
    }
    const floorPrefs = loadPrefs()
    observed.floor = new FloorManager(floorPrefs.floorDelayMs, enqueueSpeech, {
      resolveCue: floorPrefs.floorComposerEnabled ? resolveDynamicFloorCue : undefined,
    })
    observed.floor.start(submittedTask)
    observed.summary = new VoiceSummaryStream(sentence => {
      enqueueSpeech(sentence)
    })
    this.observedSpeech = observed
  }

  private pushObservedDelta(harnessTurn: string, delta: string): void {
    const observed = this.observedSpeech
    if (observed?.harnessTurn === harnessTurn) {
      observed.visibleTextSeen = true
      observed.floor.resultAvailable()
      observed.summary.push(delta)
    }
  }

  private resetObservedSpeech(harnessTurn: string, reason: TextResetReason): void {
    const observed = this.observedSpeech
    if (observed?.harnessTurn !== harnessTurn) return
    if (observed.visibleTextSeen) {
      observed.speechGeneration++
      observed.source.cancelSpeech?.()
      observed.speechQueue = Promise.resolve()
      observed.speechCancelled = false
      observed.speechError = undefined
    }
    observed.visibleTextSeen = false
    observed.summary = new VoiceSummaryStream(sentence => {
      if (observed.source.speak === undefined || observed.speechCancelled) return
      const generation = observed.speechGeneration
      observed.speechQueue = observed.speechQueue.then(async () => {
        if (generation !== observed.speechGeneration || observed.speechCancelled || this.connection !== observed.source || !this.turns.isCurrent(observed.turnId)) return
        await observed.source.speak?.(sentence)
      }).catch(error => {
        if (generation !== observed.speechGeneration) return
        observed.speechError = error
        observed.speechCancelled = true
      })
    })
    observed.floor.reset(reason)
    if (this.turns.isCurrent(observed.turnId)) this.setTurnPhase(observed.turnId, 'harness')
  }

  private async finishObservedTurn(harnessTurn: string, result: DelegateResult): Promise<void> {
    const observed = this.observedSpeech
    if (observed?.harnessTurn !== harnessTurn) return
    observed.floor.dispose()
    const { source, turnId } = observed
    const release = () => { if (this.observedSpeech === observed) this.observedSpeech = undefined }
    if (this.connection !== source || !this.turns.isCurrent(turnId)) {
      release()
      return
    }
    if (!result.ok) {
      this.disarmDraftAutoSend()
      observed.speechGeneration++
      observed.source.cancelSpeech?.()
      this.setTurnPhase(turnId, 'listening')
      this.setState(result.cancelled === true ? 'listening' : 'error', result.error)
      release()
      return
    }
    try {
      observed.summary.finish(result.text)
      await observed.speechQueue
      await source.waitForSpeechIdle?.()
      if (observed.speechError !== undefined && !isBargeInError(observed.speechError)) throw observed.speechError
      if (this.connection !== source || !this.turns.isCurrent(turnId)) {
        release()
        return
      }
      this.setTurnPhase(turnId, 'post-playback')
      await delay(400)
      if (this.connection !== source || !this.turns.isCurrent(turnId)) {
        release()
        return
      }
      this.setTurnPhase(turnId, 'listening')
      this.setState('listening', isBargeInError(observed.speechError)
        ? '播报已打断；识别文字保留在输入框'
        : this.hasPendingDraft()
          ? 'Harness 已完成；输入框里的后续语音正在等待发送'
          : 'Harness 已完成；继续说将自动处理')
      this.scheduleDraftAutoSend()
      release()
    } catch (error) {
      if (this.connection === source && this.turns.isCurrent(turnId)) {
        this.disarmDraftAutoSend()
        this.setTurnPhase(turnId, 'listening')
        this.setState('error', error instanceof Error ? error.message : String(error))
      }
      release()
    }
  }

  private async runHarnessTurn(source: VoiceConnection, task: string, turnId: number, taskAbort: AbortController): Promise<void> {
    let speechError: unknown
    let speechCancelled = false
    let speechQueue = Promise.resolve()
    let speechGeneration = 0
    let visibleTextSeen = false
    const enqueueSpeech = (sentence: string) => {
      if (source.speak === undefined) return
      if (this.connection === source && this.turns.isCurrent(turnId)) this.setTurnPhase(turnId, 'tts-pending')
      const generation = speechGeneration
      speechQueue = speechQueue.then(async () => {
        if (generation !== speechGeneration || speechCancelled || this.connection !== source || !this.turns.isCurrent(turnId)) return
        await source.speak?.(sentence)
      }).catch(error => {
        if (generation !== speechGeneration) return
        speechError = error
        speechCancelled = true
      })
    }
    let summary = new VoiceSummaryStream(enqueueSpeech)
    const floorPrefs = loadPrefs()
    const floor = new FloorManager(floorPrefs.floorDelayMs, enqueueSpeech, {
      resolveCue: floorPrefs.floorComposerEnabled ? resolveDynamicFloorCue : undefined,
    })
    floor.start(task)
    const result = await this.bridge.delegate(
      this.sessionId,
      task,
      taskAbort.signal,
      {
        voiceOutputContract: true,
        onTextDelta: delta => { visibleTextSeen = true; floor.resultAvailable(); summary.push(delta) },
        onTextReset: reason => {
          if (visibleTextSeen) {
            speechGeneration++
            source.cancelSpeech?.()
            speechQueue = Promise.resolve()
            speechCancelled = false
            speechError = undefined
          }
          visibleTextSeen = false
          summary = new VoiceSummaryStream(enqueueSpeech)
          floor.reset(reason)
          if (this.turns.isCurrent(turnId)) this.setTurnPhase(turnId, 'harness')
        },
      },
    )
    floor.dispose()
    if (this.taskAbort === taskAbort) this.taskAbort = undefined
    if (this.connection !== source || !this.turns.isCurrent(turnId)) return
    if (!result.ok) {
      this.disarmDraftAutoSend()
      speechGeneration++
      source.cancelSpeech?.()
      this.setTurnPhase(turnId, 'listening')
      this.setState('error', result.error)
      return
    }
    if (source.speak === undefined) {
      this.disarmDraftAutoSend()
      this.setTurnPhase(turnId, 'listening')
      this.setState('error', '当前语音连接没有独立 TTS')
      return
    }
    try {
      summary.finish(result.text)
      await speechQueue
      await source.waitForSpeechIdle?.()
      if (speechError !== undefined && !isBargeInError(speechError)) throw speechError
      if (this.connection === source && this.turns.isCurrent(turnId)) {
        this.setTurnPhase(turnId, 'post-playback')
        await delay(400)
        if (this.connection !== source || !this.turns.isCurrent(turnId)) return
        this.setTurnPhase(turnId, 'listening')
        this.setState('listening', isBargeInError(speechError)
          ? '播报已打断；新语音已保留在输入框，可发送或清空'
          : 'Harness 已完成')
        this.scheduleDraftAutoSend()
      }
    } catch (error) {
      if (this.connection === source && this.turns.isCurrent(turnId)) {
        this.disarmDraftAutoSend()
        this.setTurnPhase(turnId, 'listening')
        this.setState('error', error instanceof Error ? error.message : String(error))
      }
    }
  }

  private cancelObservedSpeech(): void {
    const observed = this.observedSpeech
    if (observed === undefined) return
    observed.floor?.dispose()
    observed.speechGeneration++
    observed.speechCancelled = true
    observed.source.cancelSpeech?.()
    this.observedSpeech = undefined
  }

  private setState(state: VoiceState, detail: string): void {
    this.snapshot = { state, detail, provider: loadPrefs().provider }
    this.emit()
  }

  private emit(): void { this.listeners.forEach(listener => listener()) }

  private setTurnPhase(turnId: number, phase: TurnPhase): void {
    if (!this.turns.transition(turnId, phase)) return
    this.connection?.setInputPhase?.(phase)
  }

  private invalidateCurrentTurn(source: VoiceConnection): void {
    this.turns.invalidate()
    source.setInputPhase?.('listening')
  }

  private takeBufferedTranscript(): string {
    const combined = this.transcriptSegments.splice(0).join('\n').trim()
    this.transcriptSource = undefined
    this.transcriptWasBusy = false
    this.transcriptCapturedWhileBusy = false
    this.transcriptVoiceprint = undefined
    return combined
  }

  private flushBufferedTranscriptToDraft(): void {
    if (this.transcriptTimer !== undefined) clearTimeout(this.transcriptTimer)
    this.transcriptTimer = undefined
    const combined = this.takeBufferedTranscript()
    if (combined !== '') this.appendToDraft(combined)
  }

  private appendToDraft(text: string): string {
    const addition = text.trim()
    if (addition === '') return this.boundDraft
    const target = this.draftTarget
    if (target === undefined) {
      this.deferredDraft = joinDraft(this.deferredDraft, addition)
      return this.deferredDraft
    }
    const next = joinDraft(this.boundDraft || target.getDraft(), addition)
    this.boundDraft = next
    this.pluginDraftWritePending = true
    target.setDraft(next)
    return next
  }

  private hasPendingDraft(): boolean {
    if (this.deferredDraft.trim() !== '') return true
    const target = this.draftTarget
    return (target?.getDraft() ?? this.boundDraft).trim() !== ''
  }

  private clearNativeSubmitPending(): void {
    this.nativeSubmitPending = false
    this.nativeSubmittedTask = ''
    if (this.nativeSubmitTimer !== undefined) clearTimeout(this.nativeSubmitTimer)
    this.nativeSubmitTimer = undefined
  }

  private armDraftAutoSend(source: VoiceConnection, meta: TranscriptMeta): void {
    const prefs = loadPrefs()
    const voiceprintBlocked = meta.voiceprint === 'rejected' || meta.voiceprint === 'unavailable'
    const voiceprintAllowed = prefs.voiceprintEnabled
      ? meta.voiceprint === 'approved'
      : prefs.voiceDraftAllowWithoutVoiceprint
    const continuation = this.draftAutoSendLease?.source === source
    const task = this.boundDraft.trim()
    if (!prefs.voiceDraftAutoSend
      || voiceprintBlocked
      || !voiceprintAllowed
      || (!meta.capturedWhileBusy && !continuation)
      || (prefs.voiceDraftSensitiveDeny && isSensitiveDraft(task))
      || isExplicitCancel(task)) {
      this.disarmDraftAutoSend()
      return
    }
    this.pauseDraftAutoSend()
    this.draftAutoSendLease = {
      source,
      expectedDraft: this.boundDraft,
      expectedDraftRev: this.pluginDraftWritePending ? undefined : this.boundDraftRev,
      generation: ++this.draftAutoSendGeneration,
    }
    this.scheduleDraftAutoSend()
  }

  private scheduleDraftAutoSend(): void {
    this.pauseDraftAutoSend()
    const lease = this.draftAutoSendLease
    if (lease === undefined || !this.isDraftAutoSendSafe(lease)) return
    const dwellMs = loadPrefs().voiceDraftDwellMs
    const generation = lease.generation
    this.draftAutoSendTimer = setTimeout(() => {
      this.draftAutoSendTimer = undefined
      const current = this.validDraftAutoSendLease(generation)
      if (current === undefined) {
        this.disarmDraftAutoSend('输入框或发送状态已变化；自动发送已取消')
        return
      }
      // Server VAD speech_started can trail the actual acoustic onset. Keep a
      // short final guard window so a user beginning the next phrase at the
      // dwell boundary still cancels before submit.
      this.setState('listening', '后续语音即将发送；继续说仍会合并')
      this.draftCommitTimer = setTimeout(() => {
        this.draftCommitTimer = undefined
        const ready = this.validDraftAutoSendLease(generation)
        if (ready === undefined) {
          this.disarmDraftAutoSend('输入框或发送状态已变化；自动发送已取消')
          return
        }
        this.submitBoundDraft(ready.source)
      }, 450)
    }, dwellMs)
    this.updateDraftAutoSendStatus()
  }

  private isDraftAutoSendSafe(lease: DraftAutoSendLease): boolean {
    return this.connection === lease.source
      && this.composerOnly
      && this.turns.phase === 'listening'
      && this.taskAbort === undefined
      && !this.nativeSubmitPending
      && !this.draftSpeechActive
      && (this.draftTarget?.getPhase?.() ?? 'plain') === 'plain'
      && this.draftTarget?.submit !== undefined
      && lease.expectedDraft.trim() !== ''
  }

  private pauseDraftAutoSend(): void {
    if (this.draftAutoSendTimer !== undefined) clearTimeout(this.draftAutoSendTimer)
    this.draftAutoSendTimer = undefined
    if (this.draftCommitTimer !== undefined) clearTimeout(this.draftCommitTimer)
    this.draftCommitTimer = undefined
    if (this.draftSpeechResumeTimer !== undefined) clearTimeout(this.draftSpeechResumeTimer)
    this.draftSpeechResumeTimer = undefined
  }

  private handleSpeechStart(source: VoiceConnection): void {
    if (this.connection !== source) return
    this.draftSpeechActive = true
    const lease = this.draftAutoSendLease
    this.pauseDraftAutoSend()
    if (lease === undefined) return
    this.setState('listening', '检测到你在继续说；等待本句识别后合并')
  }

  private handleSpeechEnd(source: VoiceConnection): void {
    if (this.connection !== source) return
    this.draftSpeechActive = false
    const lease = this.draftAutoSendLease
    if (lease === undefined || !this.isDraftAutoSendSafe(lease)) return
    const resumeMs = Math.max(500, loadPrefs().qwenMergeMs)
    const generation = lease.generation
    // Actionable finals normally arrive after speech_stopped and replace this
    // timer with a fresh merged lease. If the sound was only a cough/filler,
    // resume after the no-final grace without guessing how long speech lasts.
    this.draftSpeechResumeTimer = setTimeout(() => {
      this.draftSpeechResumeTimer = undefined
      if (this.validDraftAutoSendLease(generation) !== undefined) this.scheduleDraftAutoSend()
    }, resumeMs)
  }

  private validDraftAutoSendLease(generation: number): DraftAutoSendLease | undefined {
    const current = this.draftAutoSendLease
    const target = this.draftTarget
    if (current === undefined
      || current.generation !== generation
      || !this.isDraftAutoSendSafe(current)
      || target?.getDraft() !== current.expectedDraft
      || (current.expectedDraftRev !== undefined && target.getDraftRev?.() !== current.expectedDraftRev)
      || this.boundDraft !== current.expectedDraft) return undefined
    return current
  }

  private disarmDraftAutoSend(detail?: string): void {
    const hadLease = this.draftAutoSendLease !== undefined
    this.pauseDraftAutoSend()
    this.draftAutoSendLease = undefined
    this.draftAutoSendGeneration++
    if (detail !== undefined && hadLease && this.connection !== undefined && this.turns.phase === 'listening') {
      this.setState('listening', detail)
    }
  }

  private updateDraftAutoSendStatus(): void {
    const lease = this.draftAutoSendLease
    if (lease !== undefined && this.isDraftAutoSendSafe(lease)) {
      const seconds = Math.round(loadPrefs().voiceDraftDwellMs / 100) / 10
      this.setState('listening', `后续语音已合并；继续说会重新计时，约 ${seconds} 秒后自动发送`)
      return
    }
    this.setState('listening', '语音已写入输入框；可继续说、手动发送或清空')
  }
}

function isExplicitCancel(text: string): boolean {
  const normalized = text.replace(/[\s，。！？,.!?、]/g, '')
  return /^(停|停止|停下|别说了|取消|取消任务|不要了|算了)$/.test(normalized)
}

function isBargeInError(error: unknown): boolean {
  return error instanceof Error && error.message === '语音播放已被用户打断'
}

function isSensitiveDraft(text: string): boolean {
  return /(转账|汇款|付款|支付|购买|下单|发送验证码|验证码|密码|删除|清空|卸载|格式化|关机|重启|抹掉|永久)/.test(text)
}

function joinDraft(existing: string, addition: string): string {
  const before = existing.trimEnd()
  return before === '' ? addition : `${before}\n${addition}`
}

function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)) }
