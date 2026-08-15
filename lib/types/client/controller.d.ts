import { HarnessBridge } from './harness-delegate.ts';
import { type VoicePrefs } from './prefs.ts';
import { type RealtimeCallbacks } from './realtime.ts';
import { type TurnPhase } from './turn-coordinator.ts';
export type VoiceState = 'idle' | 'connecting' | 'listening' | 'speaking' | 'working' | 'error';
export interface VoiceSnapshot {
    state: VoiceState;
    detail: string;
    provider: 'qwen' | 'openai';
}
export interface VoiceConnection {
    connect(): Promise<void>;
    disconnect(): void;
    speak?(text: string): Promise<void>;
    waitForSpeechIdle?(): Promise<void>;
    setInputPhase?(phase: TurnPhase): void;
}
export type VoiceConnectionFactory = (prefs: VoicePrefs, callbacks: RealtimeCallbacks) => VoiceConnection;
export interface VoiceDraftTarget {
    getDraft(): string;
    setDraft(text: string): void;
    submit?(): void;
}
export declare class VoiceController {
    readonly sessionId: string;
    private readonly bridge;
    private readonly createConnection;
    private connection?;
    private snapshot;
    private readonly listeners;
    private taskAbort?;
    private connectionEpoch;
    private transcriptTimer?;
    private transcriptSource?;
    private transcriptSegments;
    private transcriptWasBusy;
    private draftTarget?;
    private boundDraft;
    private deferredDraft;
    private readonly turns;
    private composerOnly;
    private stopObserving?;
    private voiceContextTimer?;
    private observedSpeech?;
    private nativeSubmitPending;
    private nativeSubmitTimer?;
    constructor(sessionId: string, bridge: HarnessBridge, createConnection?: VoiceConnectionFactory);
    subscribe: (listener: () => void) => (() => void);
    getSnapshot: () => VoiceSnapshot;
    bindDraft(target: VoiceDraftTarget): () => void;
    toggle(): Promise<void>;
    stop(): void;
    dispose(): void;
    private bufferTranscript;
    private handleToolCall;
    private handleTranscript;
    private handleBusyTranscript;
    private stageComposerTranscript;
    private submitComposerTranscript;
    private enableNativeComposer;
    private disableNativeComposer;
    private beginObservedTurn;
    private pushObservedDelta;
    private finishObservedTurn;
    private runHarnessTurn;
    private setState;
    private emit;
    private setTurnPhase;
    private invalidateCurrentTurn;
    private takeBufferedTranscript;
    private flushBufferedTranscriptToDraft;
    private appendToDraft;
    private hasPendingDraft;
    private clearNativeSubmitPending;
}
