export { VOICE_SUMMARY_END, VOICE_SUMMARY_START } from '../voice-contract.ts';
/**
 * Consumes Harness text deltas and emits only completed sentences inside the
 * voice-summary markers. The closing marker may be split across any number of
 * chunks, so a matching suffix is retained until it becomes unambiguous.
 */
export declare class VoiceSummaryStream {
    private readonly emit;
    private input;
    private pendingSpeech;
    private started;
    private ended;
    private emitted;
    private acceptedWeight;
    constructor(emit: (sentence: string) => void);
    push(delta: string): void;
    finish(finalText: string): void;
    private drain;
    private accept;
    private emitSpeech;
}
export declare function extractVoiceSummary(text: string): string;
