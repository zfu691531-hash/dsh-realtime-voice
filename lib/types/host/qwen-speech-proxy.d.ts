import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
export type QwenSpeechKind = 'asr' | 'tts';
export declare class QwenSpeechProxy {
    private readonly resolveKey;
    private readonly server;
    private readonly sockets;
    constructor(resolveKey: () => Promise<string | undefined>);
    handle: (kind: QwenSpeechKind, req: IncomingMessage, socket: Duplex, head: Buffer) => Promise<void>;
    close(): void;
}
