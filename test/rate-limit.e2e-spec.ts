import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import type { RequestEventV1 } from '../src/events/request-event.js';
import { RequestEventPublisher } from '../src/events/request-event.publisher.js';

// Needs a real Redis: runs when REDIS_URL is set.
describe.skipIf(!process.env.REDIS_URL)('Per-garden rate limiting (e2e)', () => {
  const KEY = 'rl-key';
  const garden = randomUUID(); // fresh bucket every run
  const events: RequestEventV1[] = [];
  let upstream: http.Server;
  let controlApi: http.Server;
  let app: INestApplication;

  beforeAll(async () => {
    upstream = http.createServer((_req, res) => res.end('ok'));
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    const upstreamPort = (upstream.address() as AddressInfo).port;

    controlApi = http.createServer((req, res) => {
      if (req.headers['x-internal-key'] !== KEY || !req.url?.includes(garden)) {
        res.statusCode = 404;
        return res.end('{}');
      }
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          gardenId: garden,
          rateLimit: { rps: 1, burst: 3 },
          targets: [{ id: randomUUID(), name: 'api', baseUrl: `http://127.0.0.1:${upstreamPort}`, rules: [] }],
        }),
      );
    });
    await new Promise<void>((r) => controlApi.listen(0, '127.0.0.1', r));

    Object.assign(process.env, {
      CONTROL_API_URL: `http://127.0.0.1:${(controlApi.address() as AddressInfo).port}`,
      INTERNAL_API_KEY: KEY,
      ALLOW_PRIVATE_TARGETS: 'true',
      CONFIG_CACHE_TTL_MS: '0',
      RATE_LIMIT_ENABLED: 'true',
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(RequestEventPublisher)
      .useValue({ publish: (e: RequestEventV1) => events.push(e), onApplicationShutdown: () => undefined })
      .compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
    // let the Redis connection open (the client fails fast while connecting)
    await new Promise((r) => setTimeout(r, 300));
  });

  afterAll(async () => {
    await app.close();
    await new Promise((r) => upstream.close(r));
    await new Promise((r) => controlApi.close(r));
    delete process.env.RATE_LIMIT_ENABLED;
  });

  it('serves the burst, then answers 429 with Retry-After, and logs the refusals', async () => {
    const statuses: number[] = [];
    let refused: request.Response | undefined;
    for (let i = 0; i < 5; i++) {
      const res = await request(app.getHttpServer()).get(`/g/${garden}/api/x`).set('Origin', 'http://my-app.test');
      statuses.push(res.status);
      if (res.status === 429) refused = res;
    }
    expect(statuses).toEqual([200, 200, 200, 429, 429]);

    expect(refused!.headers['retry-after']).toBe('1');
    expect(refused!.headers['x-chaos-fault']).toBe('rate_limited');
    expect(refused!.headers['x-ratelimit-limit']).toBe('1');
    expect(refused!.headers['x-ratelimit-remaining']).toBe('0');
    expect(refused!.headers['access-control-expose-headers']).toMatch(/retry-after/i);
    expect(refused!.body).toMatchObject({ error: 'rate_limited', retryAfter: 1 });

    await new Promise((r) => setTimeout(r, 50));
    const limited = events.filter((e) => e.faults.includes('rate_limited'));
    expect(limited).toHaveLength(2);
    expect(limited[0]).toMatchObject({ status: 429, faults: ['rate_limited'], gardenId: garden });
  });

  it('lets requests through again once tokens refill', async () => {
    await new Promise((r) => setTimeout(r, 1100)); // 1 token per second
    await request(app.getHttpServer()).get(`/g/${garden}/api/x`).expect(200);
  });
});
