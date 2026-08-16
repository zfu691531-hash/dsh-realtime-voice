export type FloorResetReason = 'tool' | 'retry';
export type FloorStage = 'ack' | FloorResetReason | 'long-wait';
export interface FloorTimings {
    progressDelayMs?: number;
    longWaitMs?: number;
    maxCues?: number;
    resolveCue?: FloorCueResolver;
}
export interface FloorCueRequest {
    task: string;
    stage: FloorStage;
    ordinal: number;
    previousCues: string[];
}
export type FloorCueResolver = (request: FloorCueRequest, signal: AbortSignal) => Promise<string | undefined>;
/**
 * A latency race, not a second answering agent. Harness remains the only
 * reasoning writer. The manager gets lifecycle signals from the Harness turn
 * and emits short, task-aware speech locally; cues never enter prompt/history.
 */
export declare class FloorManager {
    private readonly delayMs;
    private readonly emit;
    private timer?;
    private resultStarted;
    private disposed;
    private task;
    private cueCount;
    private previousCues;
    private readonly progressDelayMs;
    private readonly longWaitMs;
    private readonly maxCues;
    private readonly resolveCue?;
    private generation;
    private requestAbort?;
    constructor(delayMs: number, emit: (text: string) => void, timings?: FloorTimings);
    start(task?: string): void;
    /** A visible final-answer delta owns the floor immediately. */
    resultAvailable(): void;
    /**
     * A tool call or retry invalidates any earlier visible preamble. Start a new
     * verified waiting stage, but do not claim a result or expose tool payloads.
     */
    reset(reason: FloorResetReason): void;
    dispose(): void;
    private schedule;
    private cancelTimer;
}
interface CueContext {
    task: string;
    stage: FloorStage;
    ordinal: number;
    previousCues: string[];
}
/**
 * Compose instead of selecting one fixed sentence. The task contributes a
 * short safe topic, lifecycle contributes the truthful verb, and a stable hash
 * varies syntax without random test/runtime behaviour.
 */
export declare function composeFloorCue(context: CueContext): string;
/** Kept as the public one-shot helper for older callers and tests. */
export declare function floorAcknowledgement(task: string): string;
export {};
