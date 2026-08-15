export class HarnessBridge {
    api;
    promptTimeoutMs;
    setVoiceContext;
    streamAbort = new AbortController();
    streamStarted = false;
    subscribed = new Set();
    readyWaiters = new Map();
    operations = new Map();
    recentFrames = new Map();
    reservations = new Set();
    observers = new Map();
    constructor(api, promptTimeoutMs = 30_000, setVoiceContext = updateVoiceContext) {
        this.api = api;
        this.promptTimeoutMs = promptTimeoutMs;
        this.setVoiceContext = setVoiceContext;
    }
    async delegate(sessionId, task, signal, callbacks = {}) {
        if (callbacks.voiceOutputContract !== true)
            return await this.delegateCore(sessionId, task, signal, callbacks);
        if (this.reservations.has(sessionId) || this.operations.has(sessionId))
            return { ok: false, error: '该会话已有一个语音委派任务在执行' };
        try {
            await this.setVoiceContext(sessionId, true, signal);
            return await this.delegateCore(sessionId, task, signal, callbacks);
        }
        catch (error) {
            if (signal?.aborted === true)
                return { ok: false, cancelled: true, error: '已取消' };
            return { ok: false, error: `语音输出上下文注入失败：${error instanceof Error ? error.message : String(error)}` };
        }
        finally {
            try {
                await this.setVoiceContext(sessionId, false);
            }
            catch { /* TTL is the final cleanup fallback */ }
        }
    }
    async setVoiceMode(sessionId, active, signal) {
        await this.setVoiceContext(sessionId, active, signal);
    }
    observeSession(sessionId, callbacks) {
        this.startStream();
        const observer = { callbacks, lastAssistantText: '' };
        this.observers.set(sessionId, observer);
        return () => { if (this.observers.get(sessionId) === observer)
            this.observers.delete(sessionId); };
    }
    async delegateCore(sessionId, task, signal, callbacks = {}) {
        if (this.reservations.has(sessionId) || this.operations.has(sessionId))
            return { ok: false, error: '该会话已有一个语音委派任务在执行' };
        this.reservations.add(sessionId);
        let response;
        let cancelRequested = false;
        const requestCancel = () => {
            cancelRequested = true;
            if (this.operations.has(sessionId))
                void this.cancel(sessionId);
        };
        try {
            this.startStream();
            await this.waitUntilSubscribed(sessionId, signal);
            if (signal?.aborted === true)
                return { ok: false, cancelled: true, error: '已取消' };
            signal?.addEventListener('abort', requestCancel, { once: true });
            const promptAbort = new AbortController();
            const abortForDispose = () => promptAbort.abort(this.streamAbort.signal.reason);
            const timeout = setTimeout(() => promptAbort.abort(new Error('Harness prompt 准入超时')), this.promptTimeoutMs);
            this.streamAbort.signal.addEventListener('abort', abortForDispose, { once: true });
            try {
                response = await this.api.sessions.prompt({
                    sessionId,
                    mode: 'queue',
                    content: [{ type: 'text', text: task }],
                    clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                }, promptAbort.signal);
            }
            catch (error) {
                if (cancelRequested)
                    return { ok: false, cancelled: true, error: '已取消' };
                if (this.streamAbort.signal.aborted)
                    return { ok: false, cancelled: true, error: '插件已卸载' };
                return { ok: false, error: error instanceof Error ? error.message : String(error) };
            }
            finally {
                clearTimeout(timeout);
                this.streamAbort.signal.removeEventListener('abort', abortForDispose);
            }
            if (!response.result.ok) {
                if (cancelRequested)
                    return { ok: false, cancelled: true, error: '已取消' };
                return { ok: false, error: `${response.result.error.code}: ${response.result.error.message}` };
            }
        }
        finally {
            this.reservations.delete(sessionId);
        }
        return await new Promise((resolve) => {
            const timer = setTimeout(() => this.finish(sessionId, { ok: false, error: 'Harness 任务等待超时' }), 10 * 60_000);
            const operation = {
                sessionId,
                rpcId: response.rpcId,
                phase: 'pending',
                lastAssistantText: '',
                cancelRequested,
                onTextDelta: callbacks.onTextDelta,
                settle: resolve,
                timer,
            };
            this.operations.set(sessionId, operation);
            for (const frame of [...(this.recentFrames.get(sessionId) ?? [])])
                this.consumeFrame(frame, false);
            if (cancelRequested || signal?.aborted === true)
                void this.cancel(sessionId);
        });
    }
    async cancel(sessionId) {
        const operation = this.operations.get(sessionId);
        if (operation === undefined)
            return false;
        operation.cancelRequested = true;
        if (operation.phase === 'active') {
            await this.expectOk(await this.api.sessions.cancel({ sessionId }));
            return true;
        }
        if (operation.queueItemId !== undefined) {
            const removed = await this.api.sessions.updateQueue({
                sessionId,
                itemId: operation.queueItemId,
                action: { kind: 'remove' },
            });
            if (!removed.result.ok && removed.result.error.code !== 'queue-item-not-found') {
                throw new Error(`${removed.result.error.code}: ${removed.result.error.message}`);
            }
            if (!removed.result.ok)
                await this.expectOk(await this.api.sessions.cancel({ sessionId }));
            else
                this.finish(sessionId, { ok: false, cancelled: true, error: '已取消' });
        }
        return true;
    }
    dispose() {
        this.streamAbort.abort();
        for (const sessionId of [...this.operations.keys()]) {
            this.finish(sessionId, { ok: false, cancelled: true, error: '插件已卸载' });
        }
        this.observers.clear();
    }
    /** Public for deterministic tests; production frames arrive from events.mux. */
    handleFrame(frame) {
        this.consumeFrame(frame, true);
    }
    consumeFrame(frame, record) {
        if (record && 'sessionId' in frame && typeof frame.sessionId === 'string' && frame.type !== 'session/subscribed') {
            const recent = this.recentFrames.get(frame.sessionId) ?? [];
            recent.push(frame);
            if (recent.length > 100)
                recent.shift();
            this.recentFrames.set(frame.sessionId, recent);
        }
        if (frame.type === 'session/subscribed') {
            this.subscribed.add(frame.sessionId);
            this.readyWaiters.get(frame.sessionId)?.splice(0).forEach(resolve => resolve());
            return;
        }
        if (frame.type === 'session/queue')
            return this.handleQueue(frame.sessionId, frame.items);
        if (frame.type === 'session/event')
            this.handleEvent(frame.sessionId, frame.event);
    }
    startStream() {
        if (this.streamStarted)
            return;
        this.streamStarted = true;
        void (async () => {
            while (!this.streamAbort.signal.aborted) {
                try {
                    for await (const request of this.api.events.mux({}, this.streamAbort.signal)) {
                        this.handleFrame(request.payload);
                    }
                }
                catch {
                    if (this.streamAbort.signal.aborted)
                        return;
                }
                this.subscribed.clear();
                await abortableDelay(100, this.streamAbort.signal);
            }
        })();
    }
    waitUntilSubscribed(sessionId, signal) {
        if (this.subscribed.has(sessionId))
            return Promise.resolve();
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Harness 事件流订阅超时')), 10_000);
            const done = () => { clearTimeout(timeout); resolve(); };
            const list = this.readyWaiters.get(sessionId) ?? [];
            list.push(done);
            this.readyWaiters.set(sessionId, list);
            signal?.addEventListener('abort', () => { clearTimeout(timeout); resolve(); }, { once: true });
        });
    }
    handleQueue(sessionId, items) {
        const operation = this.operations.get(sessionId);
        if (operation === undefined || operation.phase !== 'pending')
            return;
        const item = items.find(candidate => candidate.message.source?.rpcId === operation.rpcId);
        if (item !== undefined) {
            operation.queueItemId = item.id;
            if (operation.cancelRequested)
                void this.cancel(sessionId);
        }
    }
    handleEvent(sessionId, event) {
        this.handleObservedEvent(sessionId, event);
        const operation = this.operations.get(sessionId);
        if (operation === undefined)
            return;
        const turn = stringField(event.data, 'turn');
        if (event.type === 'turn/start' && turn !== undefined)
            operation.openTurn = turn;
        if (event.type === 'user/message') {
            const source = objectField(event.data, 'source');
            if (source?.rpcId === operation.rpcId) {
                operation.turn = turn ?? operation.openTurn;
                operation.phase = 'active';
                operation.queueItemId = undefined;
                if (operation.cancelRequested)
                    void this.cancel(sessionId);
            }
        }
        if (event.type === 'assistant/message' && turn === operation.turn) {
            const text = extractAssistantText(event.data?.message);
            if (text !== '')
                operation.lastAssistantText = text;
        }
        if (event.type === 'assistant/chunk' && turn === operation.turn) {
            const chunk = objectField(event.data, 'chunk');
            if (chunk?.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text !== '') {
                try {
                    operation.onTextDelta?.(chunk.text);
                }
                catch { /* speech consumers cannot break the Harness turn */ }
            }
        }
        if (event.type === 'turn/end' && turn === operation.turn) {
            const reason = objectField(event.data, 'reason');
            const kind = typeof reason?.kind === 'string' ? reason.kind : typeof event.data?.reason === 'string' ? event.data.reason : 'completed';
            if (kind === 'completed')
                this.finish(sessionId, { ok: true, text: operation.lastAssistantText || '任务已完成。' });
            else if (kind === 'aborted' || kind === 'interrupted')
                this.finish(sessionId, { ok: false, cancelled: true, error: '已取消' });
            else
                this.finish(sessionId, { ok: false, error: `Harness 任务结束：${kind}` });
        }
    }
    handleObservedEvent(sessionId, event) {
        const observer = this.observers.get(sessionId);
        if (observer === undefined)
            return;
        const turn = stringField(event.data, 'turn');
        if (event.type === 'turn/start' && turn !== undefined)
            observer.openTurn = turn;
        if (event.type === 'user/message') {
            const source = objectField(event.data, 'source');
            if (source?.kind !== 'user')
                return;
            const activeTurn = turn ?? observer.openTurn;
            if (activeTurn !== undefined) {
                observer.activeTurn = activeTurn;
                observer.lastAssistantText = '';
                observer.callbacks.onTurnStart(activeTurn);
            }
            return;
        }
        if (turn === undefined || turn !== observer.activeTurn)
            return;
        if (event.type === 'assistant/chunk') {
            const chunk = objectField(event.data, 'chunk');
            if (chunk?.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text !== '') {
                observer.callbacks.onTextDelta(turn, chunk.text);
            }
            return;
        }
        if (event.type === 'assistant/message') {
            const text = extractAssistantText(event.data?.message);
            if (text !== '')
                observer.lastAssistantText = text;
            return;
        }
        if (event.type !== 'turn/end')
            return;
        const reason = objectField(event.data, 'reason');
        const kind = typeof reason?.kind === 'string' ? reason.kind : typeof event.data?.reason === 'string' ? event.data.reason : 'completed';
        const result = kind === 'completed'
            ? { ok: true, text: observer.lastAssistantText || '任务已完成。' }
            : kind === 'aborted' || kind === 'interrupted'
                ? { ok: false, cancelled: true, error: '已取消' }
                : { ok: false, error: `Harness 任务结束：${kind}` };
        observer.callbacks.onTurnEnd(turn, result);
        observer.activeTurn = undefined;
        observer.openTurn = undefined;
        observer.lastAssistantText = '';
    }
    finish(sessionId, result) {
        const operation = this.operations.get(sessionId);
        if (operation === undefined)
            return;
        operation.phase = result.ok ? 'done' : result.cancelled === true ? 'cancelled' : 'done';
        clearTimeout(operation.timer);
        this.operations.delete(sessionId);
        operation.settle(result);
    }
    async expectOk(result) {
        if (!result.result.ok)
            throw new Error(`${result.result.error.code}: ${result.result.error.message}`);
    }
}
async function updateVoiceContext(sessionId, active, signal) {
    const response = await fetch('/dsh-realtime-voice/context', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, active }),
        signal,
    });
    if (!response.ok) {
        const body = await response.text();
        throw new Error(body || `HTTP ${response.status}`);
    }
}
async function abortableDelay(ms, signal) {
    if (signal.aborted)
        return;
    await new Promise(resolve => {
        const timer = setTimeout(done, ms);
        function done() {
            clearTimeout(timer);
            signal.removeEventListener('abort', done);
            resolve();
        }
        signal.addEventListener('abort', done, { once: true });
    });
}
export function extractAssistantText(message) {
    if (typeof message === 'string')
        return message.trim();
    if (typeof message !== 'object' || message === null)
        return '';
    const record = message;
    if (!Array.isArray(record.content))
        return typeof record.text === 'string' ? record.text.trim() : '';
    return record.content.map(part => {
        if (typeof part !== 'object' || part === null)
            return '';
        const block = part;
        // Harness assistant messages contain disjoint text, reasoning, image and
        // tool-call blocks. TTS must only receive user-visible final text.
        return block.type === 'text' && typeof block.text === 'string' ? block.text : '';
    }).join('\n').trim();
}
function objectField(value, key) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    const nested = value[key];
    return typeof nested === 'object' && nested !== null ? nested : undefined;
}
function stringField(value, key) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    const nested = value[key];
    return typeof nested === 'string' ? nested : typeof nested === 'number' ? String(nested) : undefined;
}
