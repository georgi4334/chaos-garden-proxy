import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * Per-request context that follows the request through every `await`, so
 * loggers and outgoing calls can find the request id without passing it around.
 */
interface RequestContext {
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const REQUEST_ID_HEADER = 'x-request-id';

/** Accept a caller's id only if it is short and plain, so it is safe in logs and headers. */
const VALID_ID = /^[A-Za-z0-9._:-]{8,128}$/;

export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/** Runs `fn` with a request id in context (for work that doesn't start from an HTTP request). */
export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return storage.run({ requestId }, fn);
}

export function pickRequestId(incoming: unknown): string {
  return typeof incoming === 'string' && VALID_ID.test(incoming) ? incoming : randomUUID();
}

/**
 * Express middleware: reuse the caller's x-request-id when valid, otherwise
 * make one; echo it on the response; run the rest of the request inside it.
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction) {
  const requestId = pickRequestId(req.headers[REQUEST_ID_HEADER]);
  req.headers[REQUEST_ID_HEADER] = requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);
  storage.run({ requestId }, next);
}
