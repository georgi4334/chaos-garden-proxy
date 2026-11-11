import type { Redis } from 'ioredis';
import type { ProxyConfig } from '../config/proxy-config.js';
import type { RequestEventV1 } from './request-event.js';
import { RequestEventPublisher } from './request-event.publisher.js';

const config = { eventStream: 'test:stream', eventStreamMaxLen: 500 } as ProxyConfig;

const event: RequestEventV1 = {
  v: 1,
  id: '0b0c6f0e-6f45-4a39-9a4c-2d8a9a1f5c11',
  at: '2026-11-11T10:00:00.000Z',
  gardenId: '11111111-1111-4111-8111-111111111111',
  targetId: 't1',
  targetName: 'api',
  method: 'GET',
  path: '/users',
  status: 200,
  completed: true,
  durationMs: 12,
  faults: [],
  ruleIds: [],
};

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('RequestEventPublisher', () => {
  it('does nothing when events are disabled', () => {
    const publisher = new RequestEventPublisher(null, config);
    expect(() => publisher.publish(event)).not.toThrow();
    expect(publisher.dropped).toBe(0);
  });

  it('appends the event as JSON to a capped stream', async () => {
    const xadd = vi.fn().mockResolvedValue('1-0');
    const publisher = new RequestEventPublisher({ xadd, on: vi.fn() } as unknown as Redis, config);
    publisher.publish(event);
    await flush();
    expect(xadd).toHaveBeenCalledWith('test:stream', 'MAXLEN', '~', '500', '*', 'data', JSON.stringify(event));
    expect(publisher.dropped).toBe(0);
  });

  it('never throws when Redis fails, and counts the dropped event', async () => {
    const xadd = vi.fn().mockRejectedValue(new Error("Stream isn't writeable"));
    const publisher = new RequestEventPublisher({ xadd, on: vi.fn() } as unknown as Redis, config);
    expect(() => publisher.publish(event)).not.toThrow();
    publisher.publish(event);
    await flush();
    expect(publisher.dropped).toBe(2);
  });
});
