import { Redis } from 'ioredis';
import type { ProxyConfig } from '../src/config/proxy-config.js';
import type { RequestEventV1 } from '../src/events/request-event.js';
import { RequestEventPublisher } from '../src/events/request-event.publisher.js';

// Runs against a real Redis when REDIS_URL is set (e.g. redis://localhost:6379).
describe.skipIf(!process.env.REDIS_URL)('RequestEventPublisher with real Redis', () => {
  const stream = `test:requests:${Date.now()}`;
  let redis: Redis;
  let reader: Redis;

  beforeAll(() => {
    redis = new Redis(process.env.REDIS_URL!, { enableOfflineQueue: true, maxRetriesPerRequest: 1 });
    reader = new Redis(process.env.REDIS_URL!);
  });

  afterAll(async () => {
    await reader.del(stream);
    await reader.quit();
  });

  it('writes events that can be read back, and caps the stream length', async () => {
    const publisher = new RequestEventPublisher(redis, {
      eventStream: stream,
      eventStreamMaxLen: 10,
    } as ProxyConfig);
    const base: Omit<RequestEventV1, 'id'> = {
      v: 1,
      at: new Date().toISOString(),
      gardenId: '11111111-1111-4111-8111-111111111111',
      targetId: 't1',
      targetName: 'api',
      method: 'GET',
      path: '/',
      status: 200,
      completed: true,
      durationMs: 5,
      faults: [],
      ruleIds: [],
    };
    for (let i = 0; i < 300; i++) publisher.publish({ ...base, id: `id-${i}` });

    // wait for all writes to land
    for (let i = 0; i < 100 && (await reader.xrevrange(stream, '+', '-', 'COUNT', 1)).at(0)?.[1][1]?.includes('id-299') !== true; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }

    const [[, fields]] = await reader.xrevrange(stream, '+', '-', 'COUNT', 1);
    expect(fields[0]).toBe('data');
    expect(JSON.parse(fields[1])).toMatchObject({ id: 'id-299', gardenId: base.gardenId });
    // MAXLEN ~ trims in whole blocks, so the length is near the cap, far below 300.
    expect(await reader.xlen(stream)).toBeLessThan(300);
    expect(publisher.dropped).toBe(0);
    await publisher.onApplicationShutdown();
  });
});
