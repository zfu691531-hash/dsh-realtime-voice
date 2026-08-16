const SAMPLE_RATE = 16_000;
const MAX_SAMPLES = SAMPLE_RATE * 30;
const PRE_ROLL_SAMPLES = SAMPLE_RATE;
/** Keeps only bounded in-memory PCM for the current ASR utterance. */
export class VoiceprintCapture {
    preRoll = [];
    preRollSamples = 0;
    active;
    completed = new Map();
    push(frame) {
        if (frame.length === 0)
            return;
        const copy = frame.slice();
        this.preRoll.push(copy);
        this.preRollSamples += copy.length;
        while (this.preRollSamples > PRE_ROLL_SAMPLES && this.preRoll.length > 1) {
            const removed = this.preRoll.shift();
            if (removed !== undefined)
                this.preRollSamples -= removed.length;
        }
        const active = this.active;
        if (active === undefined || active.samples >= MAX_SAMPLES)
            return;
        const remaining = MAX_SAMPLES - active.samples;
        const addition = copy.length <= remaining ? copy : copy.slice(0, remaining);
        active.frames.push(addition);
        active.samples += addition.length;
    }
    start(itemId) {
        if (itemId === '')
            return;
        const frames = this.preRoll.map(frame => frame.slice());
        this.active = { itemId, frames, samples: frames.reduce((sum, frame) => sum + frame.length, 0) };
    }
    stop(itemId) {
        const active = this.active;
        if (active === undefined)
            return;
        if (itemId !== '' && itemId !== active.itemId)
            return;
        const key = itemId || active.itemId;
        this.active = undefined;
        this.preRoll = [];
        this.preRollSamples = 0;
        if (key === '' || active.samples < SAMPLE_RATE)
            return;
        const samples = new Int16Array(Math.min(active.samples, MAX_SAMPLES));
        let offset = 0;
        for (const frame of active.frames) {
            if (offset >= samples.length)
                break;
            const addition = frame.length <= samples.length - offset ? frame : frame.subarray(0, samples.length - offset);
            samples.set(addition, offset);
            offset += addition.length;
        }
        this.completed.set(key, samples);
        while (this.completed.size > 4)
            this.completed.delete(this.completed.keys().next().value);
    }
    takeBase64(itemId) {
        const samples = this.completed.get(itemId);
        if (samples === undefined)
            return undefined;
        this.completed.delete(itemId);
        return pcmBase64(samples);
    }
    discard(itemId) {
        if (itemId !== '')
            this.completed.delete(itemId);
        if (this.active?.itemId === itemId)
            this.active = undefined;
    }
    clear() {
        this.preRoll = [];
        this.preRollSamples = 0;
        this.active = undefined;
        this.completed.clear();
    }
}
export async function getVoiceprintStatus() {
    try {
        const response = await fetch('/dsh-realtime-voice/status', { cache: 'no-store', headers: { accept: 'application/json' } });
        const body = await response.json();
        return {
            configured: response.ok && body.voiceprint?.configured === true,
            enrolled: response.ok && body.voiceprint?.enrolled === true,
        };
    }
    catch {
        return { configured: false, enrolled: false };
    }
}
export async function checkVoiceprint(operation, audio) {
    try {
        const response = await fetch('/dsh-realtime-voice/voiceprint', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ operation, audio }),
            cache: 'no-store',
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok)
            return { status: 'unavailable', error: body.error ?? `HTTP ${response.status}` };
        if (operation === 'enroll')
            return body.enrolled === true
                ? { status: 'enrolled' }
                : { status: 'unavailable', error: '声纹服务未确认录入' };
        const score = typeof body.score === 'number' && Number.isFinite(body.score) ? body.score : 0;
        return body.approved === true ? { status: 'approved', score } : { status: 'rejected', score };
    }
    catch (error) {
        return { status: 'unavailable', error: error instanceof Error ? error.message : String(error) };
    }
}
export async function deleteVoiceprint() {
    try {
        const response = await fetch('/dsh-realtime-voice/voiceprint', { method: 'DELETE', cache: 'no-store' });
        const body = await response.json().catch(() => ({}));
        return response.ok ? { ok: true } : { ok: false, error: body.error ?? `HTTP ${response.status}` };
    }
    catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}
function pcmBase64(samples) {
    const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
    let binary = '';
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
}
