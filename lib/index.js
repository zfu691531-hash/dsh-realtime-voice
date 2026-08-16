import { credentialRef } from '@deepseek-ai/dsh-credentials';
import z from '@deepseek-ai/schemastery';
import { HttpError, isLoopbackRequest, readJsonBody } from "./host/security.js";
import { exchangeOpenAiSdp, exchangeQwenSdp, parseSignalRequest, } from "./host/signaling.js";
import { QwenSpeechProxy } from "./host/qwen-speech-proxy.js";
import { TencentVoiceprintClient, validVoiceprintAudio, validVoiceprintId } from "./host/tencent-voiceprint.js";
import { cleanFloorTopic, composeFloorText, validateFloorCue } from "./host/floor-composer.js";
import { VOICE_OUTPUT_CONTEXT } from "./voice-contract.js";
export const name = 'dsh-realtime-voice';
export const inject = ['webServer', 'credentials', 'settings', 'systemPrompt'];
const PREFS_NS = 'dsh-realtime-voice';
const voiceprintClient = new TencentVoiceprintClient();
const productionDependencies = {
    exchangeOpenAi: exchangeOpenAiSdp,
    exchangeQwen: exchangeQwenSdp,
    voiceprintEnroll: async (audio, secretId, secretKey, signal) => await voiceprintClient.enroll(audio, { secretId, secretKey }, signal),
    voiceprintVerify: async (audio, voiceprintId, secretId, secretKey, signal) => await voiceprintClient.verify(audio, voiceprintId, { secretId, secretKey }, signal),
    voiceprintDelete: async (voiceprintId, secretId, secretKey, signal) => await voiceprintClient.delete(voiceprintId, { secretId, secretKey }, signal),
    composeFloor: composeFloorText,
};
const DEFAULT_INSTRUCTIONS = '请用自然、简洁、适合口语播报的中文表达，并允许用户随时打断。';
const prefsSchema = z.object({
    provider: z.string().default('qwen'),
    qwenWorkspaceId: z.string().default(''),
    qwenRegion: z.string().default('cn-beijing'),
    qwenModel: z.string().default('qwen3.5-omni-plus-realtime'),
    qwenVoice: z.string().default('Tina'),
    qwenAsrModel: z.string().default('qwen3-asr-flash-realtime'),
    qwenTtsModel: z.string().default('qwen3-tts-flash-realtime'),
    qwenTtsVoice: z.string().default('Chelsie'),
    qwenVadThreshold: z.number().default(0.85),
    qwenSilenceMs: z.number().default(700),
    qwenMergeMs: z.number().default(1200),
    floorDelayMs: z.number().default(800),
    floorComposerEnabled: z.boolean().default(true),
    qwenFloorModel: z.string().default('qwen3.5-flash'),
    openaiFloorModel: z.string().default('gpt-5-mini'),
    voiceprintEnabled: z.boolean().default(false),
    voiceprintThreshold: z.number().default(75),
    voiceprintId: z.string().default(''),
    openaiModel: z.string().default('gpt-realtime-2.1'),
    openaiVoice: z.string().default('marin'),
    instructions: z.string().default(DEFAULT_INSTRUCTIONS),
});
export function apply(ctx, dependencies = productionDependencies) {
    // cordis invokes apply(ctx, config) with the plugin's config as the second
    // argument — the installed `config: {}` would otherwise override the
    // production default and leave exchangeOpenAi/exchangeQwen undefined.
    const deps = isHostDependencies(dependencies) ? dependencies : productionDependencies;
    const activeVoiceSessions = new Map();
    const voiceContextTtlMs = 15 * 60_000;
    ctx.effect(() => ctx.systemPrompt.context({
        name: 'dsh-realtime-voice:output-contract',
        order: 900,
        text: context => {
            const sessionId = context.agent?.id;
            if (sessionId === undefined)
                return '';
            const expiresAt = activeVoiceSessions.get(sessionId);
            if (expiresAt === undefined)
                return '';
            if (expiresAt <= Date.now()) {
                activeVoiceSessions.delete(sessionId);
                return '';
            }
            return VOICE_OUTPUT_CONTEXT;
        },
    }), 'dsh-realtime-voice: model-visible output contract');
    const qwenSpeech = new QwenSpeechProxy(async () => {
        const credential = await ctx.credentials.resolve(credentialRef('DASHSCOPE_API_KEY'));
        return credential?.value;
    });
    ctx.effect(() => () => qwenSpeech.close(), 'dsh-realtime-voice: close qwen speech proxy');
    // Persist user prefs (provider, Workspace ID, model, voice, instructions)
    // through the settings service into the harness settings document, so the
    // config survives browser switches and loopback port changes. This is the
    // same document as ~/.dsh/settings.yaml; the browser localStorage is only
    // a cache on the client side.
    const settings = ctx.get('settings');
    let prefsScope;
    if (settings !== undefined) {
        ctx.effect(() => {
            try {
                prefsScope = settings.register(PREFS_NS, prefsSchema, {});
            }
            catch (error) {
                ctx.logger.warn(`dsh-realtime-voice: settings register failed: ${error instanceof Error ? error.message : String(error)}`);
                prefsScope = undefined;
            }
        }, 'dsh-realtime-voice: settings namespace');
    }
    for (const provider of ['openai', 'qwen']) {
        ctx.effect(() => ctx.webServer.register({
            kind: 'exact',
            path: `/dsh-realtime-voice/signaling/${provider}`,
            handler: (req, res) => handleSignal(ctx, deps, provider, req, res),
        }), `dsh-realtime-voice: ${provider} signaling`);
    }
    ctx.effect(() => ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-realtime-voice/status',
        handler: (req, res) => handleStatus(ctx, () => prefsScope, req, res),
    }), 'dsh-realtime-voice: status');
    ctx.effect(() => ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-realtime-voice/prefs',
        handler: (req, res) => handlePrefs(ctx, () => prefsScope, req, res),
    }), 'dsh-realtime-voice: prefs');
    ctx.effect(() => ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-realtime-voice/context',
        handler: (req, res) => handleVoiceContext(activeVoiceSessions, voiceContextTtlMs, req, res),
    }), 'dsh-realtime-voice: per-session output context');
    ctx.effect(() => ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-realtime-voice/voiceprint',
        handler: (req, res) => handleVoiceprint(ctx, deps, () => prefsScope, req, res),
    }), 'dsh-realtime-voice: optional voiceprint gate');
    ctx.effect(() => ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-realtime-voice/floor-compose',
        handler: (req, res) => handleFloorCompose(ctx, deps, () => prefsScope, req, res),
    }), 'dsh-realtime-voice: dynamic floor composer');
    for (const kind of ['asr', 'tts']) {
        ctx.effect(() => ctx.webServer.registerUpgrade({
            path: `/dsh-realtime-voice/${kind}/qwen`,
            handler: (req, socket, head) => qwenSpeech.handle(kind, req, socket, head),
        }), `dsh-realtime-voice: qwen ${kind} websocket`);
    }
    ctx.logger.info('dsh-realtime-voice host bridge ready');
}
async function handleVoiceContext(activeVoiceSessions, ttlMs, req, res) {
    try {
        if (req.method !== 'PUT')
            throw new HttpError(405, 'method not allowed');
        if (!isLoopbackRequest(req))
            throw new HttpError(403, 'loopback same-origin request required');
        const body = await readJsonBody(req);
        if (typeof body !== 'object' || body === null || Array.isArray(body))
            throw new HttpError(400, 'context body must be an object');
        const { sessionId, active } = body;
        if (typeof sessionId !== 'string' || sessionId.trim() === '' || sessionId.length > 256)
            throw new HttpError(400, 'invalid sessionId');
        if (typeof active !== 'boolean')
            throw new HttpError(400, 'active must be boolean');
        if (active)
            activeVoiceSessions.set(sessionId, Date.now() + ttlMs);
        else
            activeVoiceSessions.delete(sessionId);
        sendJson(res, 200, { ok: true });
    }
    catch (error) {
        const status = error instanceof HttpError ? error.status : 502;
        const message = error instanceof Error ? error.message : 'voice context failed';
        sendJson(res, status, { error: message });
    }
}
export function isHostDependencies(value) {
    return typeof value === 'object' && value !== null
        && typeof value.exchangeOpenAi === 'function'
        && typeof value.exchangeQwen === 'function'
        && typeof value.voiceprintEnroll === 'function'
        && typeof value.voiceprintVerify === 'function'
        && typeof value.voiceprintDelete === 'function'
        && typeof value.composeFloor === 'function';
}
async function handleFloorCompose(ctx, dependencies, getScope, req, res) {
    try {
        if (req.method !== 'POST')
            throw new HttpError(405, 'method not allowed');
        if (!isLoopbackRequest(req))
            throw new HttpError(403, 'loopback same-origin request required');
        const stored = asRecord(getScope()?.get());
        if (stored.floorComposerEnabled === false)
            throw new HttpError(409, 'dynamic floor composer is disabled');
        const body = asRecord(await readJsonBody(req, 16_000));
        const provider = body.provider === 'openai' ? 'openai' : 'qwen';
        const stage = body.stage;
        if (stage !== 'ack' && stage !== 'tool' && stage !== 'retry' && stage !== 'long-wait')
            throw new HttpError(400, 'invalid floor stage');
        const topic = cleanFloorTopic(body.task);
        if (topic === '')
            throw new HttpError(422, 'no safe floor topic');
        const previousCues = Array.isArray(body.previousCues)
            ? body.previousCues.slice(-3).map(item => validateFloorCue(item)).filter((item) => item !== undefined)
            : [];
        const ref = credentialRef(provider === 'qwen' ? 'DASHSCOPE_API_KEY' : 'OPENAI_API_KEY');
        const credential = await ctx.credentials.resolve(ref);
        if (credential === undefined || credential.value.trim() === '')
            throw new HttpError(502, `${ref} is not configured`);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error('floor composer timeout')), 1_500);
        req.once('aborted', () => controller.abort(new Error('floor composer client disconnected')));
        try {
            const cue = await dependencies.composeFloor({
                provider,
                workspaceId: typeof stored.qwenWorkspaceId === 'string' ? stored.qwenWorkspaceId : '',
                region: stored.qwenRegion === 'ap-southeast-1' ? 'ap-southeast-1' : 'cn-beijing',
                model: provider === 'qwen'
                    ? (typeof stored.qwenFloorModel === 'string' ? stored.qwenFloorModel : 'qwen3.5-flash')
                    : (typeof stored.openaiFloorModel === 'string' ? stored.openaiFloorModel : 'gpt-5-mini'),
                topic,
                stage: stage,
                previousCues,
            }, credential.value, controller.signal);
            const safe = validateFloorCue(cue);
            if (safe === undefined)
                throw new Error('floor provider returned unsafe text');
            sendJson(res, 200, { cue: safe });
        }
        finally {
            clearTimeout(timer);
        }
    }
    catch (error) {
        const status = error instanceof HttpError ? error.status : 502;
        sendJson(res, status, { error: status === 502 ? 'floor composer unavailable' : error instanceof Error ? error.message : 'floor composer failed' });
    }
}
async function handleSignal(ctx, dependencies, provider, req, res) {
    try {
        if (req.method !== 'POST')
            throw new HttpError(405, 'method not allowed');
        if (!isLoopbackRequest(req))
            throw new HttpError(403, 'loopback same-origin request required');
        const body = parseSignalRequest(await readJsonBody(req), provider);
        const ref = credentialRef(provider === 'openai' ? 'OPENAI_API_KEY' : 'DASHSCOPE_API_KEY');
        const credential = await ctx.credentials.resolve(ref);
        if (credential === undefined || credential.value.trim() === '')
            throw new HttpError(502, `${ref} is not configured`);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error('signaling timeout')), 20_000);
        try {
            const answer = provider === 'openai'
                ? await dependencies.exchangeOpenAi(body, credential.value, controller.signal)
                : await dependencies.exchangeQwen(body, credential.value, controller.signal);
            sendText(res, 200, answer, 'application/sdp');
        }
        finally {
            clearTimeout(timer);
        }
    }
    catch (error) {
        const status = error instanceof HttpError ? error.status : 502;
        const message = error instanceof Error ? error.message : 'signaling failed';
        sendJson(res, status, { error: message });
    }
}
async function handleStatus(ctx, getScope, req, res) {
    if (req.method !== 'GET')
        return sendJson(res, 405, { error: 'method not allowed' });
    if (!isLoopbackRequest(req))
        return sendJson(res, 403, { error: 'loopback same-origin request required' });
    const [openai, qwen, tencentId, tencentKey] = await Promise.all([
        ctx.credentials.describe(credentialRef('OPENAI_API_KEY')),
        ctx.credentials.describe(credentialRef('DASHSCOPE_API_KEY')),
        ctx.credentials.describe(credentialRef('TENCENT_SECRET_ID')),
        ctx.credentials.describe(credentialRef('TENCENT_SECRET_KEY')),
    ]);
    const stored = asRecord(getScope()?.get());
    sendJson(res, 200, {
        openai: { configured: openai.configured },
        qwen: { configured: qwen.configured },
        voiceprint: {
            configured: tencentId.configured && tencentKey.configured,
            enrolled: validVoiceprintId(stored.voiceprintId),
        },
        desktopMicrophone: false,
        externalBrowserRequired: true,
    });
}
async function handleVoiceprint(ctx, dependencies, getScope, req, res) {
    try {
        if (req.method !== 'POST' && req.method !== 'DELETE')
            throw new HttpError(405, 'method not allowed');
        if (!isLoopbackRequest(req))
            throw new HttpError(403, 'loopback same-origin request required');
        const scope = getScope();
        if (scope === undefined)
            throw new HttpError(503, 'settings storage unavailable');
        const stored = asRecord(scope.get());
        const voiceprintId = validVoiceprintId(stored.voiceprintId) ? stored.voiceprintId : undefined;
        const [secretId, secretKey] = await Promise.all([
            ctx.credentials.resolve(credentialRef('TENCENT_SECRET_ID')),
            ctx.credentials.resolve(credentialRef('TENCENT_SECRET_KEY')),
        ]);
        if (secretId?.value.trim() === '' || secretKey?.value.trim() === '' || secretId === undefined || secretKey === undefined) {
            throw new HttpError(502, 'Tencent voiceprint credentials are not configured');
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error('voiceprint timeout')), 10_000);
        try {
            if (req.method === 'DELETE') {
                if (voiceprintId !== undefined)
                    await dependencies.voiceprintDelete(voiceprintId, secretId.value, secretKey.value, controller.signal);
                await scope.update({ voiceprintId: '' });
                sendJson(res, 200, { ok: true, enrolled: false });
                return;
            }
            const body = asRecord(await readJsonBody(req, 1_400_000));
            if (body.operation !== 'enroll' && body.operation !== 'verify')
                throw new HttpError(400, 'invalid voiceprint operation');
            if (!validVoiceprintAudio(body.audio))
                throw new HttpError(400, 'voiceprint audio must be 1-30 seconds of base64 PCM16 at 16kHz');
            if (body.operation === 'enroll') {
                if (voiceprintId !== undefined)
                    throw new HttpError(409, 'a voiceprint is already enrolled; delete it before enrolling again');
                const enrolledId = await dependencies.voiceprintEnroll(body.audio, secretId.value, secretKey.value, controller.signal);
                if (!validVoiceprintId(enrolledId))
                    throw new Error('voiceprint provider returned an invalid identifier');
                await scope.update({ voiceprintId: enrolledId });
                sendJson(res, 200, { ok: true, enrolled: true });
                return;
            }
            if (voiceprintId === undefined)
                throw new HttpError(409, 'no voiceprint is enrolled');
            const result = await dependencies.voiceprintVerify(body.audio, voiceprintId, secretId.value, secretKey.value, controller.signal);
            const threshold = numberInRange(stored.voiceprintThreshold, 0, 100, 75);
            sendJson(res, 200, {
                ok: true,
                approved: result.decision && result.score >= threshold,
                score: Math.max(0, Math.min(100, result.score)),
            });
        }
        finally {
            clearTimeout(timer);
        }
    }
    catch (error) {
        const status = error instanceof HttpError ? error.status : 502;
        const message = error instanceof Error ? error.message : 'voiceprint request failed';
        sendJson(res, status, { error: message });
    }
}
async function handlePrefs(ctx, getScope, req, res) {
    try {
        if (req.method !== 'GET' && req.method !== 'PUT')
            throw new HttpError(405, 'method not allowed');
        if (!isLoopbackRequest(req))
            throw new HttpError(403, 'loopback same-origin request required');
        const scope = getScope();
        if (req.method === 'GET') {
            if (scope === undefined)
                return sendJson(res, 200, { hasUserData: false, prefs: {} });
            let hasUserData = false;
            const settings = ctx.get('settings');
            if (settings !== undefined) {
                const descriptor = settings.describe().find(item => item.ns === PREFS_NS);
                hasUserData = descriptor?.user !== undefined && descriptor.user !== null
                    && typeof descriptor.user === 'object'
                    && Object.keys(descriptor.user).length > 0;
            }
            const stored = scope.get() ?? {};
            sendJson(res, 200, { hasUserData, prefs: sanitizePrefs(stored) });
            return;
        }
        const body = await readJsonBody(req);
        if (typeof body !== 'object' || body === null || Array.isArray(body))
            throw new HttpError(400, 'prefs body must be an object');
        if (scope === undefined)
            throw new HttpError(503, 'settings storage unavailable');
        await scope.update(sanitizePrefs(body));
        sendJson(res, 200, { ok: true });
    }
    catch (error) {
        const status = error instanceof HttpError ? error.status : 502;
        const message = error instanceof Error ? error.message : 'prefs failed';
        sendJson(res, status, { error: message });
    }
}
function sanitizePrefs(value) {
    const source = typeof value === 'object' && value !== null ? value : {};
    const text = (v, max) => typeof v === 'string' ? v.slice(0, max) : '';
    return {
        provider: source.provider === 'openai' ? 'openai' : 'qwen',
        qwenWorkspaceId: text(source.qwenWorkspaceId, 128),
        qwenRegion: source.qwenRegion === 'ap-southeast-1' ? 'ap-southeast-1' : 'cn-beijing',
        qwenModel: text(source.qwenModel, 128) || 'qwen3.5-omni-plus-realtime',
        qwenVoice: text(source.qwenVoice, 128) || 'Tina',
        qwenAsrModel: text(source.qwenAsrModel, 128) || 'qwen3-asr-flash-realtime',
        qwenTtsModel: text(source.qwenTtsModel, 128) || 'qwen3-tts-flash-realtime',
        qwenTtsVoice: text(source.qwenTtsVoice, 128) || 'Chelsie',
        qwenVadThreshold: numberInRange(source.qwenVadThreshold, -1, 1, 0.85),
        qwenSilenceMs: numberInRange(source.qwenSilenceMs, 200, 6000, 700),
        qwenMergeMs: numberInRange(source.qwenMergeMs, 100, 5000, 1200),
        floorDelayMs: numberInRange(source.floorDelayMs, 400, 3000, 800),
        floorComposerEnabled: source.floorComposerEnabled !== false,
        qwenFloorModel: text(source.qwenFloorModel, 128) || 'qwen3.5-flash',
        openaiFloorModel: text(source.openaiFloorModel, 128) || 'gpt-5-mini',
        voiceprintEnabled: source.voiceprintEnabled === true,
        voiceprintThreshold: numberInRange(source.voiceprintThreshold, 0, 100, 75),
        openaiModel: text(source.openaiModel, 128) || 'gpt-realtime-2.1',
        openaiVoice: text(source.openaiVoice, 128) || 'marin',
        instructions: text(source.instructions, 12_000) || DEFAULT_INSTRUCTIONS,
    };
}
function asRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}
function numberInRange(value, min, max, fallback) {
    return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}
function sendJson(res, status, value) {
    sendText(res, status, JSON.stringify(value), 'application/json; charset=utf-8');
}
function sendText(res, status, body, contentType) {
    res.writeHead(status, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
}
export { isLoopbackRequest, readJsonBody } from "./host/security.js";
export { normalizeSdp, parseSignalRequest, qwenEndpoint } from "./host/signaling.js";
