import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import z from '@deepseek-ai/schemastery';
import { type SignalRequest } from './host/signaling.ts';
export declare const name = "dsh-realtime-voice";
export declare const inject: string[];
interface CredentialService {
    resolve(ref: ReturnType<typeof credentialRef>): Promise<{
        value: string;
        source: string;
    } | undefined>;
    describe(ref: ReturnType<typeof credentialRef>): Promise<{
        configured: boolean;
        source?: string;
        writable: boolean;
    }>;
}
interface WebServerService {
    register(route: {
        kind: 'exact';
        path: string;
        handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
    }): () => void;
    registerUpgrade(route: {
        path: string;
        handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>;
    }): () => void;
}
interface SettingsService {
    register<T>(ns: string, schema: z<T>, options?: object): SettingsScope<T>;
    describe(options?: {
        redactSecrets?: boolean;
    }): Array<{
        ns: string;
        user?: unknown;
    }>;
}
interface SettingsScope<T> {
    get(): T;
    update(patch: object): Promise<void>;
}
interface PromptAssembleContext {
    agent?: {
        id: string;
    };
}
interface SystemPromptService {
    context(input: {
        name: string;
        order: number;
        text: string | ((context: PromptAssembleContext) => string);
    }): () => void;
}
interface HostContext {
    credentials: CredentialService;
    webServer: WebServerService;
    systemPrompt: SystemPromptService;
    get(name: 'settings'): SettingsService | undefined;
    get(name: string): unknown;
    effect(callback: () => void | (() => void), label?: string): void;
    logger: {
        info(message: string, ...args: unknown[]): void;
        warn(message: string, ...args: unknown[]): void;
    };
}
export interface HostDependencies {
    exchangeOpenAi(request: SignalRequest, key: string, signal: AbortSignal): Promise<string>;
    exchangeQwen(request: SignalRequest, key: string, signal: AbortSignal): Promise<string>;
}
export declare function apply(ctx: HostContext, dependencies?: HostDependencies): void;
export declare function isHostDependencies(value: unknown): value is HostDependencies;
export { isLoopbackRequest, readJsonBody } from './host/security.ts';
export { normalizeSdp, parseSignalRequest, qwenEndpoint } from './host/signaling.ts';
