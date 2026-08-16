import { checkVoiceprint, getVoiceprintStatus, VoiceprintCapture } from "./voiceprint.js";
export class QwenPipelineConnection {
    prefs;
    callbacks;
    asr;
    tts;
    microphone;
    captureContext;
    captureSource;
    processor;
    silentGain;
    player = new PcmPlayer();
    ttsReady;
    resolveTtsReady;
    rejectTtsReady;
    speechResolve;
    speechReject;
    disposed = false;
    speechAudible = false;
    currentSpeechText = '';
    inputPhase = 'listening';
    bargeInGate = new LocalBargeInGate();
    bargeInCandidate = false;
    bargeInTimer;
    ttsStartedAt = 0;
    ttsInterruptedForBargeIn = false;
    speechEpoch = 0;
    asrEventTail = Promise.resolve();
    quarantinedItems = new Set();
    ignoredItems = new Set();
    utteranceBusy = new Map();
    asrRestarting = false;
    asrContaminated = false;
    voiceprintCapture = new VoiceprintCapture();
    voiceprintDispatchTail = Promise.resolve();
    voiceprintEpoch = 0;
    voiceprintHandledItems = new Set();
    voiceprintConfigured = false;
    voiceprintEnrolled = false;
    constructor(prefs, callbacks) {
        this.prefs = prefs;
        this.callbacks = callbacks;
    }
    async connect() {
        this.callbacks.onState('connecting');
        if (this.prefs.qwenWorkspaceId.trim() === '')
            throw new Error('请先在插件设置中填写阿里云百炼 Workspace ID');
        if (navigator.mediaDevices?.getUserMedia === undefined)
            throw new Error('当前页面无法访问麦克风，请用 Chrome 打开此 Harness 地址');
        this.microphone = await navigator.mediaDevices.getUserMedia({
            // AGC makes distant people louder and caused false turns in a shared
            // room. Keep AEC/NS but prefer a near-field speaker by leaving gain
            // unamplified; users can lower the VAD threshold for quiet microphones.
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false, channelCount: 1 },
        });
        if (this.prefs.voiceprintEnabled) {
            const status = await getVoiceprintStatus();
            this.voiceprintConfigured = status.configured;
            this.voiceprintEnrolled = status.enrolled;
        }
        await this.openTts();
        await this.openAsr();
        this.startCapture();
    }
    async speak(text) {
        const epoch = this.speechEpoch;
        const chunks = splitForTts(text);
        if (chunks.length === 0 || this.disposed)
            return;
        if (this.tts?.readyState !== WebSocket.OPEN)
            await this.openTts();
        await this.ttsReady;
        if (this.speechEpoch !== epoch)
            throw new Error('语音已被替换');
        if (this.disposed || this.tts?.readyState !== WebSocket.OPEN)
            throw new Error('千问 TTS 连接已关闭');
        this.currentSpeechText = joinSpeechText(this.currentSpeechText, text);
        for (const chunk of chunks) {
            // Cancellation can land after one commit resolves but before the next
            // chunk is sent. Revalidate every iteration so a stale generation never
            // writes into a freshly reconnected TTS socket.
            if (this.speechEpoch !== epoch)
                throw new Error('语音已被替换');
            if (this.disposed || this.tts?.readyState !== WebSocket.OPEN)
                throw new Error('千问 TTS 连接已关闭');
            await new Promise((resolve, reject) => {
                this.speechResolve = resolve;
                this.speechReject = reject;
                this.sendTts({ type: 'input_text_buffer.append', event_id: eventId(), text: chunk });
                this.sendTts({ type: 'input_text_buffer.commit', event_id: eventId() });
            });
        }
    }
    async waitForSpeechIdle() {
        await this.player.waitUntilIdle();
        this.speechAudible = false;
        this.currentSpeechText = '';
    }
    cancelSpeech() {
        this.speechEpoch++;
        if (this.isTtsActive() || this.speechResolve !== undefined || this.speechReject !== undefined)
            this.interruptTts();
    }
    setInputPhase(phase) {
        if (this.inputPhase === phase)
            return;
        this.inputPhase = phase;
        if (phase === 'tts-speaking') {
            this.ttsStartedAt = Date.now();
            this.ttsInterruptedForBargeIn = false;
            this.resetBargeIn(false);
            return;
        }
        if (phase === 'post-playback') {
            if (this.bargeInCandidate)
                this.rejectFalseBargeIn();
            else {
                this.resetBargeIn(true);
                if (this.asrContaminated)
                    this.restartAsr();
            }
            return;
        }
        if (phase === 'listening' || phase === 'harness' || phase === 'tts-pending')
            this.resetBargeIn(false);
    }
    disconnect() {
        this.disposed = true;
        this.player.dispose();
        this.processor?.disconnect();
        this.captureSource?.disconnect();
        this.silentGain?.disconnect();
        void this.captureContext?.close();
        this.microphone?.getTracks().forEach(track => track.stop());
        finishAndClose(this.asr);
        finishAndClose(this.tts);
        this.asr = undefined;
        this.tts = undefined;
        this.speechReject?.(new Error('语音连接已关闭'));
        this.speechResolve = undefined;
        this.speechReject = undefined;
        this.speechAudible = false;
        this.currentSpeechText = '';
        this.resetBargeIn(false);
        this.quarantinedItems.clear();
        this.ignoredItems.clear();
        this.utteranceBusy.clear();
        this.voiceprintCapture.clear();
        this.voiceprintHandledItems.clear();
        this.voiceprintEpoch++;
        this.voiceprintDispatchTail = Promise.resolve();
    }
    async openAsr() {
        const socket = new WebSocket(proxyUrl('asr', this.prefs.qwenWorkspaceId, this.prefs.qwenRegion, this.prefs.qwenAsrModel));
        this.asr = socket;
        await opened(socket);
        socket.onmessage = event => {
            this.asrEventTail = this.asrEventTail.then(() => this.handleAsr(event.data), () => this.handleAsr(event.data));
        };
        socket.onerror = () => this.callbacks.onState('error', '千问专用 ASR 连接失败');
        socket.onclose = () => {
            if (this.asr !== socket)
                return;
            this.asr = undefined;
            if (!this.disposed)
                this.callbacks.onState('error', '千问专用 ASR 已断开');
        };
        this.sendAsr({
            type: 'session.update',
            event_id: eventId(),
            session: {
                input_audio_format: 'pcm',
                sample_rate: 16000,
                input_audio_transcription: { language: 'zh' },
                turn_detection: {
                    type: 'server_vad',
                    threshold: this.prefs.qwenVadThreshold,
                    silence_duration_ms: this.prefs.qwenSilenceMs,
                },
            },
        });
    }
    async openTts() {
        if (this.tts?.readyState === WebSocket.OPEN || this.tts?.readyState === WebSocket.CONNECTING)
            return await this.ttsReady;
        this.ttsReady = new Promise((resolve, reject) => {
            this.resolveTtsReady = resolve;
            this.rejectTtsReady = reject;
        });
        const socket = new WebSocket(proxyUrl('tts', this.prefs.qwenWorkspaceId, this.prefs.qwenRegion, this.prefs.qwenTtsModel));
        this.tts = socket;
        // Qwen may emit session.created immediately after the WebSocket opens.
        // Install handlers first or a fast connection can miss that first event
        // and leave the UI stuck in "connecting" forever.
        socket.onmessage = event => this.handleTts(event.data);
        socket.onerror = () => this.rejectTtsReady?.(new Error('千问专用 TTS 连接失败'));
        socket.onclose = () => {
            if (this.tts !== socket)
                return;
            this.tts = undefined;
            this.speechReject?.(new Error('千问专用 TTS 已断开'));
            this.speechResolve = undefined;
            this.speechReject = undefined;
        };
        await opened(socket);
        await this.ttsReady;
    }
    startCapture() {
        if (this.microphone === undefined)
            return;
        const context = new AudioContext();
        const source = context.createMediaStreamSource(this.microphone);
        const processor = context.createScriptProcessor(2048, 1, 1);
        const silent = context.createGain();
        silent.gain.value = 0;
        processor.onaudioprocess = event => {
            if (this.asr?.readyState !== WebSocket.OPEN)
                return;
            const pcm = downsampleToPcm16(event.inputBuffer.getChannelData(0), context.sampleRate, 16000);
            if (pcm.byteLength === 0 || this.asr.bufferedAmount > 512 * 1024)
                return;
            if (this.inputPhase === 'post-playback')
                return;
            if (this.inputPhase === 'tts-speaking') {
                if (!this.speechAudible && !this.player.isPlaying)
                    return;
                const decision = this.bargeInGate.push(pcm, Date.now() - this.ttsStartedAt);
                if (!decision.forward)
                    return;
                if (!this.bargeInCandidate) {
                    this.bargeInCandidate = true;
                    this.asrContaminated = true;
                    this.player.pause();
                    this.bargeInTimer = setTimeout(() => this.rejectFalseBargeIn(), 2_200);
                    for (const frame of decision.preRoll)
                        this.appendAsr(frame);
                    return;
                }
            }
            else {
                this.bargeInGate.observe(pcm);
            }
            this.appendAsr(pcm);
        };
        source.connect(processor);
        processor.connect(silent);
        silent.connect(context.destination);
        this.captureContext = context;
        this.captureSource = source;
        this.processor = processor;
        this.silentGain = silent;
    }
    async handleAsr(raw) {
        const event = jsonEvent(raw);
        if (event === undefined)
            return;
        const type = event.type;
        if (type === 'session.updated')
            this.callbacks.onState('listening');
        if (type === 'input_audio_buffer.speech_started') {
            const itemId = typeof event.item_id === 'string' ? event.item_id : '';
            if (itemId !== '') {
                if (this.prefs.voiceprintEnabled)
                    this.voiceprintCapture.start(itemId);
                this.utteranceBusy.set(itemId, this.inputPhase !== 'listening' && this.inputPhase !== 'endpoint-candidate');
                if (this.bargeInCandidate)
                    this.quarantinedItems.add(itemId);
            }
        }
        if (type === 'input_audio_buffer.speech_stopped' && this.prefs.voiceprintEnabled) {
            const itemId = typeof event.item_id === 'string' ? event.item_id : '';
            this.voiceprintCapture.stop(itemId);
        }
        if (type === 'conversation.item.input_audio_transcription.text' && this.bargeInCandidate) {
            const confirmed = typeof event.text === 'string' ? event.text : '';
            const stash = typeof event.stash === 'string' ? event.stash : '';
            const preview = `${confirmed}${stash}`.trim();
            if (isExplicitBargeIn(normalizeSpeech(preview)) && !isLikelyTtsEcho(preview, this.currentSpeechText))
                this.interruptTts();
        }
        if (type === 'conversation.item.input_audio_transcription.completed') {
            const transcript = typeof event.transcript === 'string' ? event.transcript.trim() : '';
            const itemId = typeof event.item_id === 'string' ? event.item_id : '';
            if (this.prefs.voiceprintEnabled && itemId !== '') {
                if (this.voiceprintHandledItems.has(itemId)) {
                    this.voiceprintCapture.discard(itemId);
                    return;
                }
                this.voiceprintHandledItems.add(itemId);
                while (this.voiceprintHandledItems.size > 128)
                    this.voiceprintHandledItems.delete(this.voiceprintHandledItems.values().next().value);
            }
            const capturedWhileBusy = itemId !== ''
                ? (this.utteranceBusy.get(itemId) ?? (this.inputPhase !== 'listening' && this.inputPhase !== 'endpoint-candidate'))
                : (this.inputPhase !== 'listening' && this.inputPhase !== 'endpoint-candidate');
            if (itemId !== '')
                this.utteranceBusy.delete(itemId);
            if (itemId !== '' && this.ignoredItems.delete(itemId)) {
                this.voiceprintCapture.discard(itemId);
                return;
            }
            const quarantined = this.bargeInCandidate || (itemId !== '' && this.quarantinedItems.delete(itemId));
            if (quarantined && (!isActionableTranscript(transcript) || isLikelyTtsEcho(transcript, this.currentSpeechText))) {
                this.voiceprintCapture.discard(itemId);
                this.rejectFalseBargeIn();
                return;
            }
            if (!isActionableTranscript(transcript)) {
                this.voiceprintCapture.discard(itemId);
                return;
            }
            if (quarantined)
                this.interruptTts();
            if (this.inputPhase === 'post-playback' && !quarantined) {
                this.voiceprintCapture.discard(itemId);
                return;
            }
            if (this.prefs.voiceprintEnabled) {
                this.voiceprintDispatchTail = this.voiceprintDispatchTail.then(() => this.dispatchVoiceprintTranscript(itemId, transcript, capturedWhileBusy), () => this.dispatchVoiceprintTranscript(itemId, transcript, capturedWhileBusy));
                return;
            }
            await this.callbacks.onTranscript?.(transcript, {
                capturedWhileBusy,
                voiceprint: this.prefs.voiceprintEnabled ? 'approved' : undefined,
            });
        }
        if (type === 'error')
            this.callbacks.onState('error', safeError(event));
    }
    handleTts(raw) {
        const event = jsonEvent(raw);
        if (event === undefined)
            return;
        if (event.type === 'session.created') {
            this.sendTts({
                type: 'session.update',
                event_id: eventId(),
                session: {
                    voice: this.prefs.qwenTtsVoice,
                    mode: 'commit',
                    language_type: 'Chinese',
                    response_format: 'pcm',
                    sample_rate: 24000,
                },
            });
        }
        if (event.type === 'session.updated') {
            this.resolveTtsReady?.();
            this.resolveTtsReady = undefined;
            this.rejectTtsReady = undefined;
        }
        if (event.type === 'response.audio.delta' && typeof event.delta === 'string') {
            if (!this.speechAudible) {
                this.speechAudible = true;
                this.callbacks.onState('speaking');
            }
            this.player.enqueue(event.delta, 24000);
        }
        if (event.type === 'response.done') {
            this.speechResolve?.();
            this.speechResolve = undefined;
            this.speechReject = undefined;
        }
        if (event.type === 'error') {
            const error = new Error(safeError(event));
            this.rejectTtsReady?.(error);
            this.speechReject?.(error);
            this.speechResolve = undefined;
            this.speechReject = undefined;
        }
    }
    isTtsActive() {
        return this.speechAudible || this.player.isPlaying;
    }
    interruptTts() {
        if (this.ttsInterruptedForBargeIn)
            return;
        this.ttsInterruptedForBargeIn = true;
        this.player.stop();
        const rejectSpeech = this.speechReject;
        this.speechResolve = undefined;
        this.speechReject = undefined;
        rejectSpeech?.(new Error('语音播放已被用户打断'));
        const socket = this.tts;
        if (socket !== undefined)
            socket.close(1000, 'barge-in');
        this.tts = undefined;
        this.ttsReady = undefined;
        this.speechAudible = false;
        this.currentSpeechText = '';
        this.resetBargeIn(false);
        if (!this.disposed)
            void this.openTts().catch(error => this.callbacks.onState('error', error instanceof Error ? error.message : String(error)));
    }
    rejectFalseBargeIn() {
        if (!this.bargeInCandidate)
            return;
        for (const itemId of this.quarantinedItems)
            this.ignoredItems.add(itemId);
        this.quarantinedItems.clear();
        this.resetBargeIn(true);
        this.restartAsr();
    }
    resetBargeIn(resume) {
        if (this.bargeInTimer !== undefined)
            clearTimeout(this.bargeInTimer);
        this.bargeInTimer = undefined;
        this.bargeInCandidate = false;
        this.bargeInGate.reset();
        if (resume)
            this.player.resume();
    }
    appendAsr(pcm) {
        if (this.prefs.voiceprintEnabled)
            this.voiceprintCapture.push(pcm);
        this.sendAsr({ type: 'input_audio_buffer.append', event_id: eventId(), audio: base64(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength)) });
    }
    beginVoiceprintCheck(itemId) {
        const audio = this.voiceprintCapture.takeBase64(itemId);
        if (audio === undefined)
            return Promise.resolve({ status: 'unavailable', error: '有效人声不足一秒' });
        if (!this.voiceprintConfigured)
            return Promise.resolve({ status: 'unavailable', error: '腾讯云声纹凭据未配置' });
        const operation = this.voiceprintEnrolled ? 'verify' : 'enroll';
        return checkVoiceprint(operation, audio).then(result => {
            if (result.status === 'enrolled')
                this.voiceprintEnrolled = true;
            return result;
        });
    }
    async dispatchVoiceprintTranscript(itemId, transcript, capturedWhileBusy) {
        const epoch = this.voiceprintEpoch;
        this.voiceprintCapture.stop(itemId);
        const voiceprint = await this.beginVoiceprintCheck(itemId);
        if (this.disposed || epoch !== this.voiceprintEpoch)
            return;
        if (voiceprint.status === 'enrolled') {
            this.callbacks.onState('listening', '声纹录入成功；请再说一次刚才的指令');
            return;
        }
        if (voiceprint.status !== 'approved') {
            const detail = voiceprint.status === 'rejected'
                ? `声纹未通过（${Math.round(voiceprint.score)}分）；文字已保留，可手动发送`
                : '声纹暂不可用；文字已保留，可手动发送';
            this.callbacks.onState('listening', detail);
            await this.callbacks.onTranscript?.(transcript, {
                capturedWhileBusy: true,
                voiceprint: voiceprint.status,
            });
            return;
        }
        await this.callbacks.onTranscript?.(transcript, { capturedWhileBusy, voiceprint: 'approved' });
    }
    restartAsr() {
        if (this.disposed || this.asrRestarting)
            return;
        this.asrRestarting = true;
        this.asrContaminated = false;
        this.voiceprintCapture.clear();
        this.voiceprintHandledItems.clear();
        this.voiceprintEpoch++;
        this.voiceprintDispatchTail = Promise.resolve();
        const socket = this.asr;
        this.asr = undefined;
        socket?.close(1000, 'reset contaminated input');
        void this.openAsr().catch(error => {
            if (!this.disposed)
                this.callbacks.onState('error', error instanceof Error ? error.message : String(error));
        }).finally(() => { this.asrRestarting = false; });
    }
    sendAsr(event) { this.asr?.send(JSON.stringify(event)); }
    sendTts(event) { this.tts?.send(JSON.stringify(event)); }
}
export function isLikelyTtsEcho(transcript, speech) {
    const heard = normalizeSpeech(transcript);
    const spoken = normalizeSpeech(speech);
    if (heard.length < 3 || spoken.length < 3 || isExplicitBargeIn(heard))
        return false;
    if (spoken.includes(heard))
        return true;
    if (heard.length >= 6 && heard.includes(spoken))
        return true;
    const shorter = Math.min(heard.length, spoken.length);
    const longer = Math.max(heard.length, spoken.length);
    if (shorter / longer < 0.25)
        return false;
    if (longestCommonSubstring(heard, spoken) / shorter >= 0.72)
        return true;
    return bigramDice(heard, spoken) >= 0.62;
}
function isExplicitBargeIn(normalized) {
    return /^(停|停止|停下|打住|别说了|等一下|等等|不对|取消|取消任务|不要了|算了)$/.test(normalized);
}
function normalizeSpeech(text) {
    return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}
function joinSpeechText(existing, addition) {
    const clean = addition.trim();
    return existing === '' ? clean : clean === '' ? existing : `${existing} ${clean}`;
}
function longestCommonSubstring(left, right) {
    const row = new Uint16Array(right.length + 1);
    let longest = 0;
    for (let i = 1; i <= left.length; i++) {
        for (let j = right.length; j >= 1; j--) {
            const value = left.charAt(i - 1) === right.charAt(j - 1) ? (row[j - 1] ?? 0) + 1 : 0;
            row[j] = value;
            if (value > longest)
                longest = value;
        }
    }
    return longest;
}
function bigramDice(left, right) {
    if (left.length < 2 || right.length < 2)
        return left === right ? 1 : 0;
    const counts = new Map();
    for (let index = 0; index < left.length - 1; index++) {
        const gram = left.slice(index, index + 2);
        counts.set(gram, (counts.get(gram) ?? 0) + 1);
    }
    let overlap = 0;
    for (let index = 0; index < right.length - 1; index++) {
        const gram = right.slice(index, index + 2);
        const count = counts.get(gram) ?? 0;
        if (count <= 0)
            continue;
        overlap++;
        counts.set(gram, count - 1);
    }
    return (2 * overlap) / (left.length + right.length - 2);
}
export class LocalBargeInGate {
    noiseFloor = 0.006;
    activeMs = 0;
    candidate = false;
    bufferedMs = 0;
    frames = [];
    observe(pcm) {
        const level = pcmRms(pcm);
        if (level < 0.05)
            this.noiseFloor = (this.noiseFloor * 0.98) + (level * 0.02);
    }
    push(pcm, playbackElapsedMs) {
        const durationMs = (pcm.length / 16_000) * 1_000;
        this.frames.push({ pcm: pcm.slice(), durationMs });
        this.bufferedMs += durationMs;
        while (this.bufferedMs > 850 && this.frames.length > 1) {
            const removed = this.frames.shift();
            if (removed !== undefined)
                this.bufferedMs -= removed.durationMs;
        }
        if (this.candidate)
            return { forward: true, preRoll: [] };
        // The first playback frames are the most likely to leak through AEC. This
        // mirrors mature realtime stacks that require some audible output before
        // accepting barge-in.
        if (playbackElapsedMs < 350)
            return { forward: false, preRoll: [] };
        const threshold = Math.max(0.018, this.noiseFloor * 3.2);
        const level = pcmRms(pcm);
        this.activeMs = level >= threshold ? this.activeMs + durationMs : Math.max(0, this.activeMs - (durationMs * 1.5));
        if (this.activeMs < 500)
            return { forward: false, preRoll: [] };
        this.candidate = true;
        return { forward: true, preRoll: this.frames.map(frame => frame.pcm) };
    }
    reset() {
        this.activeMs = 0;
        this.candidate = false;
        this.bufferedMs = 0;
        this.frames = [];
    }
}
function pcmRms(pcm) {
    if (pcm.length === 0)
        return 0;
    let sum = 0;
    for (let index = 0; index < pcm.length; index++) {
        const value = (pcm[index] ?? 0) / 32768;
        sum += value * value;
    }
    return Math.sqrt(sum / pcm.length);
}
class PcmPlayer {
    context;
    gain;
    nextStart = 0;
    sources = new Set();
    idleWaiters = [];
    paused = false;
    get isPlaying() { return this.sources.size > 0; }
    enqueue(encoded, sampleRate) {
        const bytes = fromBase64(encoded);
        if (bytes.byteLength < 2)
            return;
        const context = this.context ??= new AudioContext();
        if (this.gain === undefined) {
            this.gain = context.createGain();
            this.gain.connect(context.destination);
        }
        const samples = new Float32Array(Math.floor(bytes.byteLength / 2));
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        for (let index = 0; index < samples.length; index++)
            samples[index] = view.getInt16(index * 2, true) / 32768;
        const buffer = context.createBuffer(1, samples.length, sampleRate);
        buffer.copyToChannel(samples, 0);
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(this.gain);
        const start = Math.max(context.currentTime + 0.02, this.nextStart);
        source.start(start);
        this.nextStart = start + buffer.duration;
        this.sources.add(source);
        source.onended = () => {
            this.sources.delete(source);
            this.resolveIdle();
        };
    }
    duck(enabled) {
        if (this.gain !== undefined && this.context !== undefined) {
            this.gain.gain.setTargetAtTime(enabled ? 0.25 : 1, this.context.currentTime, 0.03);
        }
    }
    pause() {
        if (this.context === undefined || this.paused)
            return;
        this.paused = true;
        void this.context.suspend();
    }
    resume() {
        if (this.context === undefined || !this.paused)
            return;
        this.paused = false;
        void this.context.resume();
    }
    stop() {
        this.resume();
        for (const source of this.sources) {
            try {
                source.stop();
            }
            catch { /* already stopped */ }
        }
        this.sources.clear();
        this.nextStart = 0;
        this.duck(false);
        this.resolveIdle();
    }
    async waitUntilIdle() {
        if (this.sources.size === 0)
            return;
        await new Promise(resolve => this.idleWaiters.push(resolve));
    }
    resolveIdle() {
        if (this.sources.size !== 0)
            return;
        this.idleWaiters.splice(0).forEach(resolve => resolve());
    }
    dispose() { this.stop(); void this.context?.close(); this.context = undefined; this.gain = undefined; this.paused = false; }
}
function proxyUrl(kind, workspaceId, region, model) {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const query = new URLSearchParams({ workspaceId, region, model });
    return `${protocol}//${location.host}/dsh-realtime-voice/${kind}/qwen?${query}`;
}
function opened(socket) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            cleanup();
            try {
                socket.close();
            }
            catch { /* already closed */ }
            reject(new Error('本地语音代理连接超时'));
        }, 10_000);
        const onOpen = () => { cleanup(); resolve(); };
        const onError = () => { cleanup(); reject(new Error('本地语音代理连接失败')); };
        const cleanup = () => {
            clearTimeout(timer);
            socket.removeEventListener('open', onOpen);
            socket.removeEventListener('error', onError);
        };
        socket.addEventListener('open', onOpen, { once: true });
        socket.addEventListener('error', onError, { once: true });
    });
}
function finishAndClose(socket) {
    if (socket?.readyState !== WebSocket.OPEN)
        return socket?.close();
    socket.send(JSON.stringify({ type: 'session.finish', event_id: eventId() }));
    setTimeout(() => socket.close(1000, 'finished'), 200);
}
function jsonEvent(raw) {
    try {
        const value = JSON.parse(typeof raw === 'string' ? raw : String(raw));
        return typeof value === 'object' && value !== null ? value : undefined;
    }
    catch {
        return undefined;
    }
}
function safeError(event) {
    const error = typeof event.error === 'object' && event.error !== null ? event.error : event;
    return typeof error.message === 'string' ? error.message.slice(0, 300) : '语音服务错误';
}
function eventId() { return `event_${crypto.randomUUID()}`; }
function isActionableTranscript(text) {
    const normalized = text.replace(/[\s，。！？,.!?、]/g, '');
    return normalized !== '' && !/^(嗯+|啊+|呃+|额+|唔+|哦+|哈+)$/.test(normalized);
}
/** Keep only speakable prose and stay below Qwen's weighted text limit. */
export function splitForTts(text, maxWeight = 1000) {
    const spoken = text
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<\/?[^>]+>/g, ' ')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/[`*_#>|<]/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    if (spoken === '')
        return [];
    const units = spoken.split(/(?<=[。！？!?；;：:\n])/u).map(value => value.trim()).filter(Boolean);
    const chunks = [];
    let current = '';
    for (const unit of units) {
        for (const part of splitWeighted(unit, maxWeight)) {
            const candidate = current === '' ? part : `${current}${needsSpace(current, part) ? ' ' : ''}${part}`;
            if (ttsWeight(candidate) <= maxWeight)
                current = candidate;
            else {
                if (current !== '')
                    chunks.push(current);
                current = part;
            }
        }
    }
    if (current !== '')
        chunks.push(current);
    return chunks;
}
function splitWeighted(text, maxWeight) {
    const output = [];
    let current = '';
    let weight = 0;
    for (const char of text) {
        const charWeight = isCjk(char) ? 2 : 1;
        if (current !== '' && weight + charWeight > maxWeight) {
            output.push(current);
            current = '';
            weight = 0;
        }
        current += char;
        weight += charWeight;
    }
    if (current !== '')
        output.push(current);
    return output;
}
function ttsWeight(text) {
    let weight = 0;
    for (const char of text)
        weight += isCjk(char) ? 2 : 1;
    return weight;
}
function isCjk(char) { return /[\u3400-\u9fff\uf900-\ufaff]/u.test(char); }
function needsSpace(left, right) { return /[A-Za-z0-9]$/.test(left) && /^[A-Za-z0-9]/.test(right); }
function downsampleToPcm16(input, inputRate, outputRate) {
    const ratio = inputRate / outputRate;
    const length = Math.floor(input.length / ratio);
    const output = new Int16Array(length);
    for (let index = 0; index < length; index++) {
        const start = Math.floor(index * ratio);
        const end = Math.max(start + 1, Math.floor((index + 1) * ratio));
        let sum = 0;
        for (let at = start; at < end && at < input.length; at++)
            sum += input[at] ?? 0;
        const sample = Math.max(-1, Math.min(1, sum / (end - start)));
        output[index] = sample < 0 ? sample * 32768 : sample * 32767;
    }
    return output;
}
function base64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let index = 0; index < bytes.length; index += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    return btoa(binary);
}
function fromBase64(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++)
        bytes[index] = binary.charCodeAt(index);
    return bytes;
}
