import type { VoicePrefs } from './prefs.ts';
export declare const HARNESS_FIRST_POLICY: string;
export interface ToolCall {
    callId: string;
    name: 'delegate_to_harness' | 'cancel_harness_task';
    arguments: string;
}
export declare function sessionUpdate(prefs: VoicePrefs): Record<string, unknown>;
export declare function parseToolCall(event: unknown): ToolCall | undefined;
export declare function toolOutput(callId: string, output: unknown): Array<Record<string, unknown>>;
