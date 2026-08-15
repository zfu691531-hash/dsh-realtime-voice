import type { MuxFrame, RpcApi } from './context-types.ts';
export type DelegatePhase = 'pending' | 'active' | 'done' | 'cancelled';
export type DelegateResult = {
    ok: true;
    text: string;
} | {
    ok: false;
    cancelled?: boolean;
    error: string;
};
export interface DelegateCallbacks {
    /** Final-answer visible text only. Reasoning and tool chunks are excluded. */
    onTextDelta?(delta: string): void;
    /** The current streamed text was invalidated by retry or a later tool call. */
    onTextReset?(): void;
    /** Activate the model-visible voice output contract for this turn. */
    voiceOutputContract?: boolean;
}
export interface SessionTurnCallbacks {
    onTurnStart(turn: string): void;
    onTextDelta(turn: string, delta: string): void;
    onTextReset?(turn: string): void;
    onTurnEnd(turn: string, result: DelegateResult): void;
}
export type VoiceContextSetter = (sessionId: string, active: boolean, signal?: AbortSignal) => Promise<void>;
export declare class HarnessBridge {
    private readonly api;
    private readonly promptTimeoutMs;
    private readonly setVoiceContext;
    private readonly streamAbort;
    private streamStarted;
    private readonly subscribed;
    private readonly readyWaiters;
    private readonly operations;
    private readonly recentFrames;
    private readonly reservations;
    private readonly observers;
    constructor(api: RpcApi, promptTimeoutMs?: number, setVoiceContext?: VoiceContextSetter);
    delegate(sessionId: string, task: string, signal?: AbortSignal, callbacks?: DelegateCallbacks): Promise<DelegateResult>;
    setVoiceMode(sessionId: string, active: boolean, signal?: AbortSignal): Promise<void>;
    observeSession(sessionId: string, callbacks: SessionTurnCallbacks): () => void;
    private delegateCore;
    cancel(sessionId: string): Promise<boolean>;
    dispose(): void;
    /** Public for deterministic tests; production frames arrive from events.mux. */
    handleFrame(frame: MuxFrame): void;
    private consumeFrame;
    private startStream;
    private waitUntilSubscribed;
    private handleQueue;
    private handleEvent;
    private handleObservedEvent;
    private finish;
    private expectOk;
}
export declare function extractAssistantText(message: unknown): string;
