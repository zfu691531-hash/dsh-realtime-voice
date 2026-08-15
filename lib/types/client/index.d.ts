import type { Context } from './context-types.ts';
export declare const name = "dsh-realtime-voice-client";
export declare const inject: string[];
export declare function apply(ctx: Context): void;
export { HarnessBridge } from './harness-delegate.ts';
export { parseToolCall, sessionUpdate, toolOutput } from './protocol.ts';
