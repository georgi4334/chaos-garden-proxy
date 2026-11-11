import { currentRequestId, pickRequestId, requestIdMiddleware, runWithRequestId } from './request-context.js';
import { JsonLogger } from './json-logger.js';

describe('request id', () => {
  it('keeps a valid incoming id and replaces anything else', () => {
    expect(pickRequestId('abc-123_DEF.456')).toBe('abc-123_DEF.456');
    for (const bad of [undefined, '', 'short', 'x'.repeat(129), 'has space here', 'line\nbreak-1234', ['a', 'b']]) {
      expect(pickRequestId(bad)).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('middleware sets the header and makes the id available for the rest of the request', async () => {
    const headers: Record<string, string> = {};
    const req = { headers: { 'x-request-id': 'incoming-id-1234' } } as never;
    const res = { setHeader: (k: string, v: string) => (headers[k] = v) } as never;
    let seen: string | undefined;
    await new Promise<void>((resolve) =>
      requestIdMiddleware(req, res, () => {
        setTimeout(() => {
          seen = currentRequestId(); // survives async hops
          resolve();
        }, 1);
      }),
    );
    expect(headers['x-request-id']).toBe('incoming-id-1234');
    expect(seen).toBe('incoming-id-1234');
    expect(currentRequestId()).toBeUndefined(); // nothing leaks outside the request
  });
});

describe('JsonLogger', () => {
  it('writes one JSON object per line with service, level, context and request id', () => {
    const lines: string[] = [];
    const logger = new JsonLogger('test-svc', (l) => lines.push(l));
    runWithRequestId('req-abcdef12', () => logger.log({ msg: 'request', status: 200 }, 'HTTP'));
    logger.warn('plain message', 'Worker');
    logger.error('boom', 'Error: boom\n    at x', 'Worker');
    logger.debug('hidden at the default level');

    const [first, second, third] = lines.map((l) => JSON.parse(l));
    expect(lines).toHaveLength(3);
    expect(first).toMatchObject({ level: 'log', service: 'test-svc', context: 'HTTP', requestId: 'req-abcdef12', msg: 'request', status: 200 });
    expect(Number.isNaN(Date.parse(first.time))).toBe(false);
    expect(second).toMatchObject({ level: 'warn', context: 'Worker', msg: 'plain message' });
    expect(second.requestId).toBeUndefined();
    expect(third).toMatchObject({ level: 'error', msg: 'boom', stack: 'Error: boom\n    at x' });
  });
});
