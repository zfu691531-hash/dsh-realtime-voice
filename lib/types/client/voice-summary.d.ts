export { VOICE_SUMMARY_END, VOICE_SUMMARY_START } from '../voice-contract.ts';
/**
 * Streams only the first natural paragraph of the final visible answer.
 * Legacy voice-summary comments are accepted for in-flight/older sessions, but
 * new answers need no machine marker and therefore render cleanly in Harness.
 */
export declare class VoiceSummaryStream {
    private readonly emit;
    private input;
    private pendingSpeech;
    private mode;
    private ended;
    private emitted;
    private acceptedWeight;
    constructor(emit: (sentence: string) => void);
    push(delta: string): void;
    finish(finalText: string): void;
    private drainLead;
    private drainLegacy;
    private accept;
    private emitSpeech;
}
export declare function extractVoiceSummary(text: string): string;
