export type VoiceProviderId = 'qwen' | 'openai';
export type QwenRegion = 'cn-beijing' | 'ap-southeast-1';
export interface VoicePrefs {
    provider: VoiceProviderId;
    qwenWorkspaceId: string;
    qwenRegion: QwenRegion;
    qwenModel: string;
    qwenVoice: string;
    qwenAsrModel: string;
    qwenTtsModel: string;
    qwenTtsVoice: string;
    qwenVadThreshold: number;
    qwenSilenceMs: number;
    qwenMergeMs: number;
    floorDelayMs: number;
    voiceprintEnabled: boolean;
    voiceprintThreshold: number;
    openaiModel: string;
    openaiVoice: string;
    instructions: string;
}
export declare function loadPrefs(): VoicePrefs;
export declare function updatePrefs(patch: Partial<VoicePrefs>): VoicePrefs;
/** Push the current prefs to the host bridge so they survive browser switches and port changes. */
export declare function persistPrefs(prefs: VoicePrefs): void;
/**
 * One-shot hydration: pull prefs persisted on the host (settings document) and
 * merge them over localStorage. When the host has nothing yet but this browser
 * already has custom values (pre-fix state), push them up so they are saved.
 */
export declare function hydrateFromHost(): void;
export declare function subscribePrefs(listener: () => void): () => void;
