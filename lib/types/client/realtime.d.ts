import type { VoicePrefs } from './prefs.ts';
import { type ToolCall } from './protocol.ts';
export interface RealtimeCallbacks {
    onState(state: 'connecting' | 'listening' | 'speaking' | 'error', detail?: string): void;
    onToolCall(call: ToolCall): Promise<unknown>;
    onTranscript?(text: string, meta?: {
        capturedWhileBusy?: boolean;
    }): Promise<void>;
}
export declare class RealtimeConnection {
    private readonly prefs;
    private readonly callbacks;
    private peer?;
    private channel?;
    private inboundChannel?;
    private microphone?;
    private microphoneTrack?;
    private audioSender?;
    private audio?;
    private seenCalls;
    private sessionCreated;
    private updateSent;
    private responseActive;
    constructor(prefs: VoicePrefs, callbacks: RealtimeCallbacks);
    connect(): Promise<void>;
    disconnect(): void;
    private handleEvent;
    private send;
    private maybeSendSessionUpdate;
}
