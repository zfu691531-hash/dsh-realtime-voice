export type Provider = 'openai' | 'qwen';
export type QwenRegion = 'cn-beijing' | 'ap-southeast-1';
export interface SignalRequest {
    sdp: string;
    provider: Provider;
    model?: string;
    voice?: string;
    instructions?: string;
    workspaceId?: string;
    region?: QwenRegion;
}
export declare function parseSignalRequest(value: unknown, provider: Provider): SignalRequest;
export declare function qwenEndpoint(request: SignalRequest): string;
export declare function normalizeSdp(sdp: string): string;
export declare function exchangeQwenSdp(request: SignalRequest, apiKey: string, signal: AbortSignal): Promise<string>;
export declare function exchangeOpenAiSdp(request: SignalRequest, apiKey: string, signal: AbortSignal): Promise<string>;
