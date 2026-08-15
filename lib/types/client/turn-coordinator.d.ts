export type TurnPhase = 'listening' | 'endpoint-candidate' | 'harness' | 'tts-pending' | 'tts-speaking' | 'post-playback';
/**
 * Owns voice turn identity and serializes every state-changing event. Audio,
 * Harness and TTS callbacks can arrive from unrelated transports; allowing
 * them to mutate the controller directly is what previously produced mixed
 * turns and stale playback.
 */
export declare class TurnCoordinator {
    private currentPhase;
    private currentTurn;
    private tail;
    get phase(): TurnPhase;
    get turnId(): number;
    begin(): number;
    transition(turnId: number, phase: TurnPhase): boolean;
    isCurrent(turnId: number): boolean;
    invalidate(): void;
    enqueue<T>(operation: () => Promise<T> | T): Promise<T>;
}
