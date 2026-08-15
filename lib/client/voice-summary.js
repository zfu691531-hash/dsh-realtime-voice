import { VOICE_SUMMARY_END, VOICE_SUMMARY_START } from "../voice-contract.js";
export { VOICE_SUMMARY_END, VOICE_SUMMARY_START } from "../voice-contract.js";
const MAX_SUMMARY_WEIGHT = 240;
/**
 * Streams only the first natural paragraph of the final visible answer.
 * Legacy voice-summary comments are accepted for in-flight/older sessions, but
 * new answers need no machine marker and therefore render cleanly in Harness.
 */
export class VoiceSummaryStream {
    emit;
    input = '';
    pendingSpeech = '';
    mode = 'undecided';
    ended = false;
    emitted = false;
    acceptedWeight = 0;
    constructor(emit) {
        this.emit = emit;
    }
    push(delta) {
        if (delta === '' || this.ended)
            return;
        this.input += delta;
        if (this.mode === 'undecided') {
            const normalized = normalizeSummaryMarkers(this.input);
            const legacyStart = normalized.indexOf(VOICE_SUMMARY_START);
            if (legacyStart >= 0) {
                this.mode = 'legacy';
                this.input = normalized.slice(legacyStart + VOICE_SUMMARY_START.length);
            }
            else if (couldBeLegacyPrefix(this.input)) {
                return;
            }
            else {
                this.mode = 'lead';
                this.input = this.input.trimStart();
                if (isUnsafeLead(this.input)) {
                    this.input = '';
                    this.ended = true;
                    return;
                }
            }
        }
        if (this.mode === 'legacy')
            this.drainLegacy();
        else
            this.drainLead(false);
    }
    finish(finalText) {
        if (!this.ended) {
            if (this.mode === 'undecided') {
                const fallback = extractVoiceSummary(finalText);
                if (fallback !== '')
                    this.emitSpeech(fallback);
                this.ended = true;
                return;
            }
            if (this.mode === 'legacy')
                this.drainLegacy();
            else
                this.drainLead(true);
        }
        if (this.pendingSpeech.trim() !== '')
            this.emitSpeech(this.pendingSpeech);
        this.pendingSpeech = '';
        if (!this.emitted) {
            const fallback = extractVoiceSummary(finalText);
            if (fallback !== '')
                this.emitSpeech(fallback);
        }
    }
    drainLead(final) {
        const separator = paragraphBoundary(this.input);
        if (separator !== undefined) {
            this.accept(this.input.slice(0, separator.index), true);
            this.input = '';
            this.ended = true;
            return;
        }
        if (final) {
            this.accept(this.input, true);
            this.input = '';
            this.ended = true;
            return;
        }
        const held = partialParagraphSuffixLength(this.input);
        const safeLength = this.input.length - held;
        if (safeLength <= 0)
            return;
        this.accept(this.input.slice(0, safeLength), false);
        this.input = this.input.slice(safeLength);
    }
    drainLegacy() {
        this.input = normalizeSummaryMarkers(this.input);
        const end = this.input.indexOf(VOICE_SUMMARY_END);
        if (end >= 0) {
            this.accept(this.input.slice(0, end), true);
            this.input = '';
            this.ended = true;
            return;
        }
        const held = Math.max(partialMarkerSuffixLength(this.input, VOICE_SUMMARY_END), partialHtmlCommentSuffixLength(this.input));
        const safeLength = this.input.length - held;
        if (safeLength <= 0)
            return;
        this.accept(this.input.slice(0, safeLength), false);
        this.input = this.input.slice(safeLength);
    }
    accept(text, flush) {
        const remaining = MAX_SUMMARY_WEIGHT - this.acceptedWeight;
        if (remaining <= 0) {
            if (flush && this.pendingSpeech.trim() !== '') {
                this.emitSpeech(this.pendingSpeech);
                this.pendingSpeech = '';
            }
            return;
        }
        const bounded = takeWeighted(text, remaining);
        this.acceptedWeight += speechWeight(bounded);
        this.pendingSpeech += bounded;
        let boundary = completedSentenceBoundary(this.pendingSpeech);
        while (boundary > 0) {
            const sentence = this.pendingSpeech.slice(0, boundary);
            this.pendingSpeech = this.pendingSpeech.slice(boundary);
            this.emitSpeech(sentence);
            boundary = completedSentenceBoundary(this.pendingSpeech);
        }
        if (flush && this.pendingSpeech.trim() !== '') {
            this.emitSpeech(this.pendingSpeech);
            this.pendingSpeech = '';
        }
    }
    emitSpeech(text) {
        const clean = cleanSpeechText(text);
        if (clean === '')
            return;
        this.emitted = true;
        this.emit(clean);
    }
}
export function extractVoiceSummary(text) {
    const normalized = normalizeSummaryMarkers(text);
    const start = normalized.indexOf(VOICE_SUMMARY_START);
    if (start >= 0) {
        const bodyStart = start + VOICE_SUMMARY_START.length;
        const end = normalized.indexOf(VOICE_SUMMARY_END, bodyStart);
        if (end < 0)
            return '';
        return cleanSpeechText(takeWeighted(normalized.slice(bodyStart, end), MAX_SUMMARY_WEIGHT));
    }
    const body = text.trimStart();
    if (body === '' || isUnsafeLead(body))
        return '';
    const separator = paragraphBoundary(body);
    const lead = separator === undefined ? body : body.slice(0, separator.index);
    if (/<!--|-->/u.test(lead))
        return '';
    return cleanSpeechText(takeWeighted(lead, MAX_SUMMARY_WEIGHT));
}
function normalizeSummaryMarkers(text) {
    return text
        .replace(/<!--\s*voice-summary\s*-->/gi, VOICE_SUMMARY_START)
        .replace(/<!--\s*\/voice-summary\s*-->/gi, VOICE_SUMMARY_END);
}
function couldBeLegacyPrefix(text) {
    const trimmed = text.trimStart();
    if (trimmed === '')
        return true;
    return '<!-- voice-summary -->'.startsWith(trimmed.toLowerCase())
        || '<!--voice-summary-->'.startsWith(trimmed.toLowerCase());
}
function isUnsafeLead(text) {
    return /^(?:`|<!--|<|\{|\[|#|\*|>|-|\+\s|\d+[.、)]|\||[•·])/u.test(text.trimStart());
}
function paragraphBoundary(text) {
    const match = /\r?\n[\t ]*\r?\n/u.exec(text);
    if (match === null || match.index === undefined)
        return undefined;
    return { index: match.index, length: match[0].length };
}
function partialParagraphSuffixLength(text) {
    const match = /\r?\n[\t ]*$/u.exec(text);
    return match === null ? 0 : match[0].length;
}
function completedSentenceBoundary(text) {
    const match = /[。！？!?；;](?:[”’」』】）)])?/u.exec(text);
    if (match === null || match.index === undefined)
        return 0;
    return match.index + match[0].length;
}
function cleanSpeechText(text) {
    return text
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<\/?[^>]+>/g, ' ')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/!??\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/[>*_~]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}
function partialHtmlCommentSuffixLength(text) {
    const open = text.lastIndexOf('<!--');
    if (open >= 0 && text.indexOf('-->', open + 4) < 0)
        return text.length - open;
    for (const prefix of ['<!-', '<!', '<'])
        if (text.endsWith(prefix))
            return prefix.length;
    return 0;
}
function partialMarkerSuffixLength(text, marker) {
    const max = Math.min(text.length, marker.length - 1);
    for (let length = max; length > 0; length--) {
        if (text.endsWith(marker.slice(0, length)))
            return length;
    }
    return 0;
}
function takeWeighted(text, limit) {
    let weight = 0;
    let result = '';
    for (const char of text) {
        const next = speechWeight(char);
        if (weight + next > limit)
            break;
        result += char;
        weight += next;
    }
    return result;
}
function speechWeight(text) {
    let value = 0;
    for (const char of text)
        value += /[\u3400-\u9fff\uf900-\ufaff]/u.test(char) ? 2 : 1;
    return value;
}
