export type FloorProvider = 'qwen' | 'openai';
export type FloorStage = 'ack' | 'tool' | 'retry' | 'long-wait';
export interface FloorComposeRequest {
    provider: FloorProvider;
    workspaceId: string;
    region: 'cn-beijing' | 'ap-southeast-1';
    model: string;
    topic: string;
    stage: FloorStage;
    previousCues: string[];
}
export declare function composeFloorText(input: FloorComposeRequest, key: string, signal: AbortSignal): Promise<string>;
export declare function cleanFloorTopic(value: unknown): string;
export declare function validateFloorCue(value: unknown): string | undefined;
