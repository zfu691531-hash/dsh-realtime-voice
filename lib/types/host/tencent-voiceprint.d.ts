export interface TencentVoiceprintCredentials {
    secretId: string;
    secretKey: string;
}
export interface VoiceprintVerifyResult {
    decision: boolean;
    score: number;
}
type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
export declare class TencentVoiceprintClient {
    private readonly fetchImpl;
    private readonly now;
    constructor(fetchImpl?: FetchLike, now?: () => number);
    enroll(audio: string, credentials: TencentVoiceprintCredentials, signal?: AbortSignal): Promise<string>;
    verify(audio: string, voiceprintId: string, credentials: TencentVoiceprintCredentials, signal?: AbortSignal): Promise<VoiceprintVerifyResult>;
    delete(voiceprintId: string, credentials: TencentVoiceprintCredentials, signal?: AbortSignal): Promise<void>;
    private call;
}
export declare function validVoiceprintAudio(audio: unknown): audio is string;
export declare function validVoiceprintId(value: unknown): value is string;
export {};
