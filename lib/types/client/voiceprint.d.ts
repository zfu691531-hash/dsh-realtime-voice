export type VoiceprintOperation = 'enroll' | 'verify';
export type VoiceprintGateResult = {
    status: 'enrolled';
} | {
    status: 'approved';
    score: number;
} | {
    status: 'rejected';
    score: number;
} | {
    status: 'unavailable';
    error: string;
};
export interface VoiceprintStatus {
    configured: boolean;
    enrolled: boolean;
}
/** Keeps only bounded in-memory PCM for the current ASR utterance. */
export declare class VoiceprintCapture {
    private preRoll;
    private preRollSamples;
    private active?;
    private readonly completed;
    push(frame: Int16Array): void;
    start(itemId: string): void;
    stop(itemId: string): void;
    takeBase64(itemId: string): string | undefined;
    discard(itemId: string): void;
    clear(): void;
}
export declare function getVoiceprintStatus(): Promise<VoiceprintStatus>;
export declare function checkVoiceprint(operation: VoiceprintOperation, audio: string): Promise<VoiceprintGateResult>;
export declare function deleteVoiceprint(): Promise<{
    ok: true;
} | {
    ok: false;
    error: string;
}>;
