import { FloorManager } from "./floor-manager.js";
import { loadPrefs } from "./prefs.js";
import { RealtimeConnection } from "./realtime.js";
import { QwenPipelineConnection } from "./qwen-pipeline.js";
import { TurnCoordinator } from "./turn-coordinator.js";
import { VoiceSummaryStream } from "./voice-summary.js";
export class VoiceController {
    sessionId;
    bridge;
    createConnection;
    connection;
    snapshot = { state: 'idle', detail: '', provider: loadPrefs().provider };
    listeners = new Set();
    taskAbort;
    connectionEpoch = 0;
    transcriptTimer;
    transcriptSource;
    transcriptSegments = [];
    transcriptWasBusy = false;
    draftTarget;
    boundDraft = '';
    deferredDraft = '';
    turns = new TurnCoordinator();
    composerOnly = false;
    stopObserving;
    voiceContextTimer;
    observedSpeech;
    nativeSubmitPending = false;
    nativeSubmitTimer;
    nativeSubmittedTask = '';
    constructor(sessionId, bridge, createConnection = (prefs, callbacks) => prefs.provider === 'qwen'
        ? new QwenPipelineConnection(prefs, callbacks)
        : new RealtimeConnection(prefs, callbacks)) {
        this.sessionId = sessionId;
        this.bridge = bridge;
        this.createConnection = createConnection;
    }
    subscribe = (listener) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };
    getSnapshot = () => this.snapshot;
    bindDraft(target) {
        this.draftTarget = target;
        this.boundDraft = target.getDraft();
        if (this.deferredDraft !== '') {
            this.appendToDraft(this.deferredDraft);
            this.deferredDraft = '';
        }
        return () => { if (this.draftTarget === target)
            this.draftTarget = undefined; };
    }
    async toggle() {
        if (this.connection !== undefined)
            return this.stop();
        if (new URLSearchParams(location.search).has('dsh-desktop-platform')) {
            this.setState('error', '桌面壳暂不开放麦克风；正在用默认浏览器打开同一会话');
            window.open(location.href.replace(/([?&])dsh-desktop-platform=[^&]*&?/, '$1').replace(/[?&]$/, ''), '_blank', 'noopener');
            return;
        }
        const prefs = loadPrefs();
        this.snapshot = { state: 'connecting', detail: '', provider: prefs.provider };
        this.emit();
        const epoch = ++this.connectionEpoch;
        let connection;
        connection = this.createConnection(prefs, {
            onState: (state, detail) => {
                if (this.connection !== connection)
                    return;
                if (state === 'speaking' && this.turns.phase === 'tts-pending')
                    this.setTurnPhase(this.turns.turnId, 'tts-speaking');
                if (state === 'listening' && this.turns.phase !== 'listening' && this.turns.phase !== 'endpoint-candidate')
                    return;
                if (this.taskAbort === undefined)
                    this.setState(state, detail ?? '');
            },
            onToolCall: call => this.handleToolCall(connection, call),
            onTranscript: (text, meta) => this.turns.enqueue(() => this.bufferTranscript(connection, text, meta?.capturedWhileBusy === true)),
        });
        this.connection = connection;
        try {
            if (prefs.provider === 'qwen') {
                const enabled = this.enableNativeComposer(connection);
                this.composerOnly = typeof enabled === 'boolean' ? enabled : await enabled;
            }
            await connection.connect();
        }
        catch (error) {
            this.disableNativeComposer();
            connection.disconnect();
            if (this.connectionEpoch !== epoch || this.connection !== connection)
                return;
            this.connection = undefined;
            this.setState('error', error instanceof Error ? error.message : String(error));
        }
    }
    stop() {
        this.connectionEpoch++;
        this.turns.invalidate();
        this.flushBufferedTranscriptToDraft();
        this.taskAbort?.abort();
        this.taskAbort = undefined;
        this.clearNativeSubmitPending();
        this.disableNativeComposer();
        this.cancelObservedSpeech();
        const connection = this.connection;
        this.connection = undefined;
        connection?.disconnect();
        this.setState('idle', '');
    }
    dispose() { this.stop(); this.listeners.clear(); }
    async bufferTranscript(source, transcript, capturedWhileBusy = false) {
        if (this.connection !== source)
            return;
        const segment = transcript.trim();
        if (segment === '')
            return;
        if (this.transcriptSource !== undefined && this.transcriptSource !== source)
            this.flushBufferedTranscriptToDraft();
        this.transcriptSource = source;
        this.transcriptSegments.push(segment);
        const wasBusy = capturedWhileBusy
            || this.hasPendingDraft()
            || this.nativeSubmitPending
            || this.taskAbort !== undefined
            || (this.turns.phase !== 'listening' && this.turns.phase !== 'endpoint-candidate');
        this.transcriptWasBusy ||= wasBusy;
        if (!wasBusy && this.turns.phase === 'listening')
            this.setTurnPhase(this.turns.turnId, 'endpoint-candidate');
        if (this.transcriptTimer !== undefined)
            clearTimeout(this.transcriptTimer);
        this.transcriptTimer = setTimeout(() => {
            this.transcriptTimer = undefined;
            const wasBusy = this.transcriptWasBusy;
            const combined = this.takeBufferedTranscript();
            if (combined !== '')
                void this.turns.enqueue(() => this.composerOnly
                    ? wasBusy ? this.stageComposerTranscript(source, combined) : this.submitComposerTranscript(source, combined)
                    : wasBusy ? this.handleBusyTranscript(source, combined) : this.handleTranscript(source, combined));
        }, loadPrefs().qwenMergeMs);
    }
    async handleToolCall(source, call) {
        if (this.connection !== source)
            return { ok: false, error: '语音连接已关闭' };
        if (call.name === 'cancel_harness_task') {
            this.taskAbort?.abort();
            const cancelled = await this.bridge.cancel(this.sessionId);
            if (this.connection === source) {
                this.invalidateCurrentTurn(source);
                this.setState('listening', cancelled ? 'Harness 任务已取消' : '没有正在执行的 Harness 任务');
            }
            return { ok: true, cancelled };
        }
        let task = '';
        try {
            const args = JSON.parse(call.arguments);
            if (typeof args.task === 'string')
                task = args.task.trim();
        }
        catch { /* validated below */ }
        if (task === '')
            return { ok: false, error: 'delegate_to_harness 缺少 task' };
        this.setState('working', task.slice(0, 100));
        const taskAbort = new AbortController();
        this.taskAbort = taskAbort;
        const result = await this.bridge.delegate(this.sessionId, task, taskAbort.signal);
        if (this.taskAbort === taskAbort)
            this.taskAbort = undefined;
        if (this.connection === source)
            this.setState('listening', result.ok ? 'Harness 已完成' : result.error);
        return result;
    }
    async handleTranscript(source, transcript) {
        if (this.connection !== source)
            return;
        const task = transcript.trim();
        if (task === '')
            return;
        // A background utterance must never kill a Harness turn that is already
        // using tools. Only an explicit spoken cancel command may do that. General
        // barge-in remains available while TTS is speaking, after the Harness turn
        // has completed.
        if (this.taskAbort !== undefined) {
            if (isExplicitCancel(task)) {
                const active = this.taskAbort;
                active.abort();
                const cancelled = await this.bridge.cancel(this.sessionId);
                if (this.taskAbort === active)
                    this.taskAbort = undefined;
                if (this.connection === source) {
                    this.invalidateCurrentTurn(source);
                    this.setState('listening', cancelled ? 'Harness 任务已取消' : '没有正在执行的 Harness 任务');
                }
            }
            else {
                this.appendToDraft(task);
                this.setState('working', '继续任务：新语音已转成文字；发送后排队处理，也可以直接清空');
            }
            return;
        }
        // ASR remains open while Harness/TTS works so genuine barge-in stays
        // possible. Before audio has actually started, however, a late/background
        // final must not preempt the answer that is about to play.
        if (this.turns.phase === 'tts-pending' || this.turns.phase === 'tts-speaking' || this.turns.phase === 'post-playback') {
            this.appendToDraft(task);
            this.setState(this.turns.phase === 'tts-speaking' ? 'speaking' : 'working', '继续任务：新语音已保留在输入框；发送后处理，或直接清空');
            return;
        }
        const turnId = this.turns.begin();
        this.setTurnPhase(turnId, 'harness');
        this.setState('working', task.slice(0, 100));
        const taskAbort = new AbortController();
        this.taskAbort = taskAbort;
        void this.runHarnessTurn(source, task, turnId, taskAbort).catch(error => {
            if (this.connection !== source || !this.turns.isCurrent(turnId))
                return;
            this.setTurnPhase(turnId, 'listening');
            this.setState('error', error instanceof Error ? error.message : String(error));
        });
    }
    async handleBusyTranscript(source, transcript) {
        if (this.connection !== source)
            return;
        const task = transcript.trim();
        if (task === '')
            return;
        if (this.taskAbort !== undefined && isExplicitCancel(task)) {
            await this.handleTranscript(source, task);
            return;
        }
        this.appendToDraft(task);
        const playback = this.turns.phase === 'tts-speaking' || this.turns.phase === 'post-playback';
        this.setState(playback ? 'speaking' : this.taskAbort !== undefined ? 'working' : 'listening', '继续任务：新语音已保留在输入框；发送后处理，或直接清空');
    }
    stageComposerTranscript(source, transcript) {
        if (this.connection !== source)
            return;
        this.appendToDraft(transcript);
        if (this.turns.phase === 'endpoint-candidate')
            this.setTurnPhase(this.turns.turnId, 'listening');
        if (this.turns.phase === 'listening')
            this.setState('listening', '语音已写入输入框；继续说会合并，发送后由 Harness 处理');
    }
    submitComposerTranscript(source, transcript) {
        if (this.connection !== source)
            return;
        const target = this.draftTarget;
        if (target?.submit === undefined) {
            this.stageComposerTranscript(source, transcript);
            return;
        }
        this.appendToDraft(transcript);
        this.nativeSubmittedTask = transcript.trim();
        this.nativeSubmitPending = true;
        this.setState('working', '语音已识别，正在交给 Harness');
        queueMicrotask(() => {
            if (this.connection !== source || !this.nativeSubmitPending)
                return;
            try {
                target.submit?.();
                // The native composer clears its draft after submit, but React may not
                // rebind this target until the next render. Drop our shadow copy now so
                // speech captured during that gap cannot resurrect the submitted turn.
                this.boundDraft = '';
            }
            catch (error) {
                this.nativeSubmittedTask = '';
                this.clearNativeSubmitPending();
                if (this.turns.phase === 'endpoint-candidate')
                    this.setTurnPhase(this.turns.turnId, 'listening');
                this.setState('error', `自动发送失败，文字已保留在输入框：${error instanceof Error ? error.message : String(error)}`);
                return;
            }
            if (!this.nativeSubmitPending)
                return;
            this.nativeSubmitTimer = setTimeout(() => {
                this.nativeSubmitTimer = undefined;
                if (!this.nativeSubmitPending || this.connection !== source)
                    return;
                this.nativeSubmitPending = false;
                this.nativeSubmittedTask = '';
                if (this.turns.phase === 'endpoint-candidate')
                    this.setTurnPhase(this.turns.turnId, 'listening');
                this.setState('error', 'Harness 未确认自动发送；请检查输入框后手动发送');
            }, 10_000);
        });
    }
    enableNativeComposer(source) {
        const bridge = this.bridge;
        if (typeof bridge.observeSession !== 'function' || typeof bridge.setVoiceMode !== 'function')
            return false;
        this.stopObserving = bridge.observeSession(this.sessionId, {
            onTurnStart: harnessTurn => this.beginObservedTurn(source, harnessTurn),
            onTextDelta: (harnessTurn, delta) => this.pushObservedDelta(harnessTurn, delta),
            onTextReset: harnessTurn => this.resetObservedSpeech(harnessTurn),
            onTurnEnd: (harnessTurn, result) => { void this.finishObservedTurn(harnessTurn, result); },
        });
        return bridge.setVoiceMode(this.sessionId, true).then(() => {
            this.voiceContextTimer = setInterval(() => { void bridge.setVoiceMode?.(this.sessionId, true).catch(() => { }); }, 10 * 60_000);
            return true;
        });
    }
    disableNativeComposer() {
        this.stopObserving?.();
        this.stopObserving = undefined;
        if (this.voiceContextTimer !== undefined)
            clearInterval(this.voiceContextTimer);
        this.voiceContextTimer = undefined;
        this.clearNativeSubmitPending();
        this.cancelObservedSpeech();
        if (this.composerOnly)
            void this.bridge.setVoiceMode?.(this.sessionId, false).catch(() => { });
        this.composerOnly = false;
        this.nativeSubmittedTask = '';
    }
    beginObservedTurn(source, harnessTurn) {
        if (this.connection !== source || !this.composerOnly)
            return;
        this.cancelObservedSpeech();
        const submittedTask = this.nativeSubmittedTask;
        this.nativeSubmittedTask = '';
        this.clearNativeSubmitPending();
        const turnId = this.turns.begin();
        this.setTurnPhase(turnId, 'harness');
        this.setState('working', '输入已发送，Harness 正在处理');
        const observed = {};
        observed.harnessTurn = harnessTurn;
        observed.turnId = turnId;
        observed.source = source;
        observed.speechQueue = Promise.resolve();
        observed.speechCancelled = false;
        observed.speechGeneration = 0;
        const enqueueSpeech = (sentence) => {
            if (source.speak === undefined || observed.speechCancelled)
                return;
            const generation = observed.speechGeneration;
            if (this.connection === source && this.turns.isCurrent(turnId))
                this.setTurnPhase(turnId, 'tts-pending');
            observed.speechQueue = observed.speechQueue.then(async () => {
                if (generation !== observed.speechGeneration || observed.speechCancelled || this.connection !== source || !this.turns.isCurrent(turnId))
                    return;
                await source.speak?.(sentence);
            }).catch(error => {
                if (generation !== observed.speechGeneration)
                    return;
                observed.speechError = error;
                observed.speechCancelled = true;
            });
        };
        observed.floor = new FloorManager(loadPrefs().floorDelayMs, enqueueSpeech);
        observed.floor.start(submittedTask);
        observed.summary = new VoiceSummaryStream(sentence => {
            enqueueSpeech(sentence);
        });
        this.observedSpeech = observed;
    }
    pushObservedDelta(harnessTurn, delta) {
        const observed = this.observedSpeech;
        if (observed?.harnessTurn === harnessTurn) {
            observed.floor.resultAvailable();
            observed.summary.push(delta);
        }
    }
    resetObservedSpeech(harnessTurn) {
        const observed = this.observedSpeech;
        if (observed?.harnessTurn !== harnessTurn)
            return;
        observed.floor.resultAvailable();
        observed.speechGeneration++;
        observed.source.cancelSpeech?.();
        observed.speechQueue = Promise.resolve();
        observed.speechCancelled = false;
        observed.speechError = undefined;
        observed.summary = new VoiceSummaryStream(sentence => {
            if (observed.source.speak === undefined || observed.speechCancelled)
                return;
            const generation = observed.speechGeneration;
            observed.speechQueue = observed.speechQueue.then(async () => {
                if (generation !== observed.speechGeneration || observed.speechCancelled || this.connection !== observed.source || !this.turns.isCurrent(observed.turnId))
                    return;
                await observed.source.speak?.(sentence);
            }).catch(error => {
                if (generation !== observed.speechGeneration)
                    return;
                observed.speechError = error;
                observed.speechCancelled = true;
            });
        });
        if (this.turns.isCurrent(observed.turnId))
            this.setTurnPhase(observed.turnId, 'harness');
    }
    async finishObservedTurn(harnessTurn, result) {
        const observed = this.observedSpeech;
        if (observed?.harnessTurn !== harnessTurn)
            return;
        observed.floor.dispose();
        const { source, turnId } = observed;
        const release = () => { if (this.observedSpeech === observed)
            this.observedSpeech = undefined; };
        if (this.connection !== source || !this.turns.isCurrent(turnId)) {
            release();
            return;
        }
        if (!result.ok) {
            observed.speechGeneration++;
            observed.source.cancelSpeech?.();
            this.setTurnPhase(turnId, 'listening');
            this.setState(result.cancelled === true ? 'listening' : 'error', result.error);
            release();
            return;
        }
        try {
            observed.summary.finish(result.text);
            await observed.speechQueue;
            await source.waitForSpeechIdle?.();
            if (observed.speechError !== undefined && !isBargeInError(observed.speechError))
                throw observed.speechError;
            if (this.connection !== source || !this.turns.isCurrent(turnId)) {
                release();
                return;
            }
            this.setTurnPhase(turnId, 'post-playback');
            await delay(400);
            if (this.connection !== source || !this.turns.isCurrent(turnId)) {
                release();
                return;
            }
            this.setTurnPhase(turnId, 'listening');
            this.setState('listening', isBargeInError(observed.speechError)
                ? '播报已打断；识别文字保留在输入框'
                : this.hasPendingDraft()
                    ? 'Harness 已完成；输入框里的后续语音可发送或清空'
                    : 'Harness 已完成；继续说将自动处理');
            release();
        }
        catch (error) {
            if (this.connection === source && this.turns.isCurrent(turnId)) {
                this.setTurnPhase(turnId, 'listening');
                this.setState('error', error instanceof Error ? error.message : String(error));
            }
            release();
        }
    }
    async runHarnessTurn(source, task, turnId, taskAbort) {
        let speechError;
        let speechCancelled = false;
        let speechQueue = Promise.resolve();
        let speechGeneration = 0;
        const enqueueSpeech = (sentence) => {
            if (source.speak === undefined)
                return;
            if (this.connection === source && this.turns.isCurrent(turnId))
                this.setTurnPhase(turnId, 'tts-pending');
            const generation = speechGeneration;
            speechQueue = speechQueue.then(async () => {
                if (generation !== speechGeneration || speechCancelled || this.connection !== source || !this.turns.isCurrent(turnId))
                    return;
                await source.speak?.(sentence);
            }).catch(error => {
                if (generation !== speechGeneration)
                    return;
                speechError = error;
                speechCancelled = true;
            });
        };
        let summary = new VoiceSummaryStream(enqueueSpeech);
        const floor = new FloorManager(loadPrefs().floorDelayMs, enqueueSpeech);
        floor.start(task);
        const result = await this.bridge.delegate(this.sessionId, task, taskAbort.signal, {
            voiceOutputContract: true,
            onTextDelta: delta => { floor.resultAvailable(); summary.push(delta); },
            onTextReset: () => {
                floor.resultAvailable();
                speechGeneration++;
                source.cancelSpeech?.();
                speechQueue = Promise.resolve();
                speechCancelled = false;
                speechError = undefined;
                summary = new VoiceSummaryStream(enqueueSpeech);
                if (this.turns.isCurrent(turnId))
                    this.setTurnPhase(turnId, 'harness');
            },
        });
        floor.dispose();
        if (this.taskAbort === taskAbort)
            this.taskAbort = undefined;
        if (this.connection !== source || !this.turns.isCurrent(turnId))
            return;
        if (!result.ok) {
            speechGeneration++;
            source.cancelSpeech?.();
            this.setTurnPhase(turnId, 'listening');
            this.setState('error', result.error);
            return;
        }
        if (source.speak === undefined) {
            this.setTurnPhase(turnId, 'listening');
            this.setState('error', '当前语音连接没有独立 TTS');
            return;
        }
        try {
            summary.finish(result.text);
            await speechQueue;
            await source.waitForSpeechIdle?.();
            if (speechError !== undefined && !isBargeInError(speechError))
                throw speechError;
            if (this.connection === source && this.turns.isCurrent(turnId)) {
                this.setTurnPhase(turnId, 'post-playback');
                await delay(400);
                if (this.connection !== source || !this.turns.isCurrent(turnId))
                    return;
                this.setTurnPhase(turnId, 'listening');
                this.setState('listening', isBargeInError(speechError)
                    ? '播报已打断；新语音已保留在输入框，可发送或清空'
                    : 'Harness 已完成');
            }
        }
        catch (error) {
            if (this.connection === source && this.turns.isCurrent(turnId)) {
                this.setTurnPhase(turnId, 'listening');
                this.setState('error', error instanceof Error ? error.message : String(error));
            }
        }
    }
    cancelObservedSpeech() {
        const observed = this.observedSpeech;
        if (observed === undefined)
            return;
        observed.floor?.dispose();
        observed.speechGeneration++;
        observed.speechCancelled = true;
        observed.source.cancelSpeech?.();
        this.observedSpeech = undefined;
    }
    setState(state, detail) {
        this.snapshot = { state, detail, provider: loadPrefs().provider };
        this.emit();
    }
    emit() { this.listeners.forEach(listener => listener()); }
    setTurnPhase(turnId, phase) {
        if (!this.turns.transition(turnId, phase))
            return;
        this.connection?.setInputPhase?.(phase);
    }
    invalidateCurrentTurn(source) {
        this.turns.invalidate();
        source.setInputPhase?.('listening');
    }
    takeBufferedTranscript() {
        const combined = this.transcriptSegments.splice(0).join('\n').trim();
        this.transcriptSource = undefined;
        this.transcriptWasBusy = false;
        return combined;
    }
    flushBufferedTranscriptToDraft() {
        if (this.transcriptTimer !== undefined)
            clearTimeout(this.transcriptTimer);
        this.transcriptTimer = undefined;
        const combined = this.takeBufferedTranscript();
        if (combined !== '')
            this.appendToDraft(combined);
    }
    appendToDraft(text) {
        const addition = text.trim();
        if (addition === '')
            return;
        const target = this.draftTarget;
        if (target === undefined) {
            this.deferredDraft = joinDraft(this.deferredDraft, addition);
            return;
        }
        const next = joinDraft(this.boundDraft || target.getDraft(), addition);
        this.boundDraft = next;
        target.setDraft(next);
    }
    hasPendingDraft() {
        if (this.deferredDraft.trim() !== '')
            return true;
        const target = this.draftTarget;
        return (target?.getDraft() ?? this.boundDraft).trim() !== '';
    }
    clearNativeSubmitPending() {
        this.nativeSubmitPending = false;
        this.nativeSubmittedTask = '';
        if (this.nativeSubmitTimer !== undefined)
            clearTimeout(this.nativeSubmitTimer);
        this.nativeSubmitTimer = undefined;
    }
}
function isExplicitCancel(text) {
    const normalized = text.replace(/[\s，。！？,.!?、]/g, '');
    return /^(停|停止|停下|别说了|取消|取消任务|不要了|算了)$/.test(normalized);
}
function isBargeInError(error) {
    return error instanceof Error && error.message === '语音播放已被用户打断';
}
function joinDraft(existing, addition) {
    const before = existing.trimEnd();
    return before === '' ? addition : `${before}\n${addition}`;
}
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
