import { createHash, createHmac } from 'node:crypto';
const HOST = 'asr.tencentcloudapi.com';
const SERVICE = 'asr';
const VERSION = '2019-06-14';
const ALGORITHM = 'TC3-HMAC-SHA256';
export class TencentVoiceprintClient {
    fetchImpl;
    now;
    constructor(fetchImpl = fetch, now = Date.now) {
        this.fetchImpl = fetchImpl;
        this.now = now;
    }
    async enroll(audio, credentials, signal) {
        const response = await this.call('VoicePrintEnroll', {
            VoiceFormat: 0,
            SampleRate: 16_000,
            Data: audio,
            SpeakerNick: 'DSH Voice User',
        }, credentials, signal);
        const data = objectField(response, 'Data');
        const id = stringField(data, 'VoicePrintId');
        if (id === undefined || !validVoiceprintId(id))
            throw new Error('Tencent voiceprint enrollment returned an invalid identifier');
        return id;
    }
    async verify(audio, voiceprintId, credentials, signal) {
        if (!validVoiceprintId(voiceprintId))
            throw new Error('invalid voiceprint identifier');
        const response = await this.call('VoicePrintVerify', {
            VoiceFormat: 0,
            SampleRate: 16_000,
            VoicePrintId: voiceprintId,
            Data: audio,
        }, credentials, signal);
        const data = objectField(response, 'Data');
        const score = Number(stringField(data, 'Score') ?? numberField(data, 'Score') ?? 0);
        return { decision: numberField(data, 'Decision') === 1, score: Number.isFinite(score) ? score : 0 };
    }
    async delete(voiceprintId, credentials, signal) {
        if (!validVoiceprintId(voiceprintId))
            throw new Error('invalid voiceprint identifier');
        await this.call('VoicePrintDelete', { VoicePrintId: voiceprintId }, credentials, signal);
    }
    async call(action, payload, credentials, signal) {
        if (credentials.secretId.trim() === '' || credentials.secretKey.trim() === '')
            throw new Error('Tencent voiceprint credentials are missing');
        const body = JSON.stringify(payload);
        const timestamp = Math.floor(this.now() / 1_000);
        const date = new Date(timestamp * 1_000).toISOString().slice(0, 10);
        const contentType = 'application/json; charset=utf-8';
        const signedHeaders = 'content-type;host';
        const canonicalHeaders = `content-type:${contentType}\nhost:${HOST}\n`;
        const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${sha256(body)}`;
        const scope = `${date}/${SERVICE}/tc3_request`;
        const stringToSign = `${ALGORITHM}\n${timestamp}\n${scope}\n${sha256(canonicalRequest)}`;
        const secretDate = hmac(`TC3${credentials.secretKey}`, date);
        const secretService = hmac(secretDate, SERVICE);
        const secretSigning = hmac(secretService, 'tc3_request');
        const signature = createHmac('sha256', secretSigning).update(stringToSign).digest('hex');
        const authorization = `${ALGORITHM} Credential=${credentials.secretId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
        const response = await this.fetchImpl(`https://${HOST}/`, {
            method: 'POST',
            headers: {
                Authorization: authorization,
                'Content-Type': contentType,
                Host: HOST,
                'X-TC-Action': action,
                'X-TC-Timestamp': String(timestamp),
                'X-TC-Version': VERSION,
            },
            body,
            signal,
        });
        const parsed = await response.json().catch(() => undefined);
        if (!response.ok)
            throw new Error(`Tencent voiceprint HTTP ${response.status}`);
        const envelope = objectField(parsed, 'Response');
        if (envelope === undefined)
            throw new Error('Tencent voiceprint returned an invalid response');
        const apiError = objectField(envelope, 'Error');
        if (apiError !== undefined) {
            const code = stringField(apiError, 'Code') ?? 'UnknownError';
            const message = (stringField(apiError, 'Message') ?? 'request failed').slice(0, 180);
            throw new Error(`Tencent voiceprint ${code}: ${message}`);
        }
        return envelope;
    }
}
export function validVoiceprintAudio(audio) {
    if (typeof audio !== 'string' || audio.length < 42_668 || audio.length > 1_300_000)
        return false;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(audio))
        return false;
    const bytes = Buffer.from(audio, 'base64');
    return bytes.length >= 32_000 && bytes.length <= 960_000 && bytes.length % 2 === 0;
}
export function validVoiceprintId(value) {
    return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
}
function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}
function hmac(key, value) {
    return createHmac('sha256', key).update(value).digest();
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
    return typeof nested === 'string' ? nested : undefined;
}
function numberField(value, key) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    const nested = value[key];
    return typeof nested === 'number' ? nested : undefined;
}
