/**
 * A latency race, not a second answering agent. Harness remains the only
 * reasoning writer; this manager may emit at most one non-committal cue while
 * the first visible result token is still absent.
 */
export declare class FloorManager {
    private readonly delayMs;
    private readonly emit;
    private timer?;
    private resultStarted;
    private disposed;
    constructor(delayMs: number, emit: (text: string) => void);
    start(task?: string): void;
    resultAvailable(): void;
    dispose(): void;
    private cancelTimer;
}
export declare function floorAcknowledgement(task: string): string;
