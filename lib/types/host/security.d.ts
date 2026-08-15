import type { IncomingMessage } from 'node:http';
export declare function isLoopbackRequest(req: IncomingMessage): boolean;
export declare function readJsonBody(req: IncomingMessage, maxBytes?: number): Promise<unknown>;
export declare class HttpError extends Error {
    readonly status: number;
    constructor(status: number, message: string);
}
