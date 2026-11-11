import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import type { GardenConfig } from '../src/config/control-api.client.js';
import type { RequestEventV1 } from '../src/events/request-event.js';
import { RequestEventPublisher } from '../src/events/request-event.publisher.js';
import type { Rule } from '../src/matching/select-faults.js';

const KEY = 'e2e-internal-key';
const GARDEN = '11111111-1111-4111-8111-111111111111';
const PRIVATE_GARDEN = '22222222-2222-4222-8222-222222222222';

let upstream: http.Server;
let controlApi: http.Server;
let upstreamPort: number;
let rules: Rule[] = [];
let controlApiHits = 0;
/** Events the proxy publishes, captured by a fake publisher. */
const events: RequestEventV1[] = [];

async function waitFor(check: () => boolean, timeoutMs = 2000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const rule = (over: Partial<Rule> & Pick<Rule, 'id' | 'type'>): Rule => ({
  method: '*',
  pathPattern: '/*',
  probability: 1,
  params: {},
  ...over,
});

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

async function startApp(env: Record<string, string>, controlPort: number): Promise<INestApplication> {
  Object.assign(process.env, {
    CONTROL_API_URL: `http://127.0.0.1:${controlPort}`,
    INTERNAL_API_KEY: KEY,
    CONFIG_CACHE_TTL_MS: '0',
    UPSTREAM_TIMEOUT_MS: '2000',
    // This suite is about faults; rate limiting has its own suite (rate-limit.e2e-spec.ts).
    RATE_LIMIT_ENABLED: 'false',
    ...env,
  });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(RequestEventPublisher)
    .useValue({ publish: (event: RequestEventV1) => events.push(event) })
    .compile();
  const app = moduleRef.createNestApplication({ bodyParser: false });
  configureApp(app);
  await app.init();
  return app;
}

beforeAll(async () => {
  // A tiny "real API" the proxy forwards to: echoes method, url, headers and body.
  upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.setHeader('x-upstream', 'yes');
      res.end(
        JSON.stringify({
          method: req.method,
          url: req.url,
          host: req.headers.host,
          body: Buffer.concat(chunks).toString(),
          big: 'x'.repeat(200),
        }),
      );
    });
  });
  upstreamPort = await listen(upstream);

  // A stub control API that requires the internal key.
  controlApi = http.createServer((req, res) => {
    controlApiHits++;
    const m = /^\/internal\/gardens\/([^/]+)\/config$/.exec(req.url ?? '');
    if (req.headers['x-internal-key'] !== KEY) {
      res.statusCode = 401;
      return res.end('{}');
    }
    const gardenId = m?.[1];
    let body: GardenConfig | null = null;
    if (gardenId === GARDEN) {
      body = {
        gardenId,
        targets: [{ id: 't1', name: 'api', baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, rules }],
      };
    } else if (gardenId === PRIVATE_GARDEN) {
      body = {
        gardenId,
        targets: [{ id: 't2', name: 'internal', baseUrl: `http://127.0.0.1:${upstreamPort}`, rules: [] }],
      };
    }
    if (!body) {
      res.statusCode = 404;
      return res.end('{}');
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  });
});

afterAll(async () => {
  await new Promise((r) => upstream.close(r));
  await new Promise((r) => controlApi.close(r));
});

describe('Fault proxy (e2e), private targets allowed', () => {
  let app: INestApplication;
  const http$ = () => request(app.getHttpServer());

  beforeAll(async () => {
    const controlPort = await listen(controlApi);
    app = await startApp({ ALLOW_PRIVATE_TARGETS: 'true' }, controlPort);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    rules = [];
  });

  it('health works', async () => {
    await http$().get('/health').expect(200, { status: 'ok' });
  });

  it('passes requests through untouched, including path prefix, query, method and body', async () => {
    const res = await http$()
      .post(`/g/${GARDEN}/api/users/7?x=1&y=two`)
      .set('content-type', 'application/json')
      .send({ hello: 'world' })
      .expect(200);
    expect(res.headers['x-chaos-fault']).toBeUndefined();
    expect(res.headers['x-upstream']).toBe('yes');
    expect(res.body).toMatchObject({
      method: 'POST',
      url: '/v1/users/7?x=1&y=two', // base path /v1 + rest + query
      host: `127.0.0.1:${upstreamPort}`, // Host rewritten to the target
      body: '{"hello":"world"}',
    });
  });

  it('forwards the bare target URL with no extra path', async () => {
    const res = await http$().get(`/g/${GARDEN}/api`).expect(200);
    expect(res.body.url).toBe('/v1/');
  });

  it('allows browsers from any origin and exposes the fault header', async () => {
    const preflight = await http$()
      .options(`/g/${GARDEN}/api/users`)
      .set('Origin', 'http://my-app.test')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type')
      .expect(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('*');

    rules = [rule({ id: 'e', type: 'error', params: { status: 503 } })];
    const res = await http$().get(`/g/${GARDEN}/api/x`).set('Origin', 'http://my-app.test').expect(503);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-expose-headers']).toMatch(/x-chaos-fault/i);
  });

  it('publishes one event per proxied request, describing what happened', async () => {
    events.length = 0;
    await http$().get(`/g/${GARDEN}/api/users/7?secret=abc`).expect(200);

    rules = [rule({ id: 'e1', type: 'error', params: { status: 503 } })];
    await http$().post(`/g/${GARDEN}/api/orders`).expect(503);

    rules = [rule({ id: 'l1', type: 'latency', params: { ms: 50 } }), rule({ id: 'd1', type: 'drop' })];
    await http$().get(`/g/${GARDEN}/api/x`).catch(() => undefined); // connection is dropped

    await http$().get(`/g/33333333-3333-4333-8333-333333333333/api/x`).expect(404); // unknown garden
    await waitFor(() => events.length >= 3);
    await new Promise((r) => setTimeout(r, 50)); // give any stray 4th event a chance to appear
    expect(events).toHaveLength(3);

    const [pass, error, drop] = events;
    expect(pass).toMatchObject({
      v: 1,
      gardenId: GARDEN,
      targetId: 't1',
      targetName: 'api',
      method: 'GET',
      path: '/users/7', // query string is never logged
      status: 200,
      completed: true,
      faults: [],
      ruleIds: [],
    });
    expect(pass.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number.isNaN(Date.parse(pass.at))).toBe(false);
    expect(pass.durationMs).toBeGreaterThanOrEqual(0);

    expect(error).toMatchObject({ method: 'POST', path: '/orders', status: 503, faults: ['error'], ruleIds: ['e1'] });
    expect(drop).toMatchObject({ status: null, completed: false, faults: ['latency', 'drop'], ruleIds: ['l1', 'd1'] });
    expect(drop.durationMs).toBeGreaterThanOrEqual(45);
    expect(new Set(events.map((e) => e.id)).size).toBe(3);
  });

  it('returns 404 for unknown gardens, targets and malformed ids', async () => {
    await http$().get(`/g/33333333-3333-4333-8333-333333333333/api/x`).expect(404);
    await http$().get(`/g/${GARDEN}/nope/x`).expect(404);
    await http$().get(`/g/not-a-uuid/api/x`).expect(404);
  });

  it('error rule: 100% returns the injected status without calling upstream', async () => {
    rules = [rule({ id: 'e', type: 'error', params: { status: 503 } })];
    const res = await http$().get(`/g/${GARDEN}/api/anything`).expect(503);
    expect(res.headers['x-chaos-fault']).toBe('error');
    expect(res.body).toMatchObject({ error: 'chaos_garden_injected_error', status: 503 });
    expect(res.headers['x-upstream']).toBeUndefined();
  });

  it('latency rule: delays the response, then forwards normally', async () => {
    rules = [rule({ id: 'l', type: 'latency', params: { ms: 300 } })];
    const start = Date.now();
    const res = await http$().get(`/g/${GARDEN}/api/slow`).expect(200);
    expect(Date.now() - start).toBeGreaterThanOrEqual(290);
    expect(res.headers['x-chaos-fault']).toBe('latency');
    expect(res.headers['x-upstream']).toBe('yes');
  });

  it('latency + error rules combine', async () => {
    rules = [
      rule({ id: 'l', type: 'latency', params: { ms: 150 } }),
      rule({ id: 'e', type: 'error', params: { status: 500 } }),
    ];
    const start = Date.now();
    const res = await http$().get(`/g/${GARDEN}/api/x`).expect(500);
    expect(Date.now() - start).toBeGreaterThanOrEqual(140);
    expect(res.headers['x-chaos-fault']).toBe('latency,error');
  });

  it('drop rule: the connection is closed with no response', async () => {
    rules = [rule({ id: 'd', type: 'drop' })];
    const server = app.getHttpServer();
    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as AddressInfo).port;
        const req = http.get(`http://127.0.0.1:${port}/g/${GARDEN}/api/x`, () =>
          reject(new Error('expected no response')),
        );
        req.on('error', (err: NodeJS.ErrnoException) => {
          try {
            expect(['ECONNRESET', 'UND_ERR_SOCKET']).toContain(err.code);
            resolve();
          } catch (e) {
            reject(e);
          } finally {
            server.close();
          }
        });
      });
    });
  });

  it('corrupt rule: forwards but the body no longer parses as JSON', async () => {
    rules = [rule({ id: 'c', type: 'corrupt' })];
    const res = await http$().get(`/g/${GARDEN}/api/data`).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks).toString()));
    });
    expect(res.status).toBe(200);
    expect(res.headers['x-chaos-fault']).toBe('corrupt');
    expect(() => JSON.parse(res.body as string)).toThrow();
    expect(res.body as string).toContain('"method":"GET"'); // the start is kept
  });

  it('rules only affect matching method and path', async () => {
    rules = [rule({ id: 'e', type: 'error', method: 'POST', pathPattern: '/orders/*', params: { status: 500 } })];
    await http$().get(`/g/${GARDEN}/api/orders/1`).expect(200);
    await http$().post(`/g/${GARDEN}/api/users`).expect(200);
    await http$().post(`/g/${GARDEN}/api/orders/1`).expect(500);
  });

  it('a 50% rule faults roughly half of many requests', async () => {
    rules = [rule({ id: 'e', type: 'error', probability: 0.5, params: { status: 503 } })];
    const results = await Promise.all(
      Array.from({ length: 200 }, () => http$().get(`/g/${GARDEN}/api/x`).then((r) => r.status)),
    );
    const faulted = results.filter((s) => s === 503).length;
    expect(faulted).toBeGreaterThan(60);
    expect(faulted).toBeLessThan(140);
  });

  it('rejects oversized request bodies declared via content-length', async () => {
    const res = await http$()
      .post(`/g/${GARDEN}/api/upload`)
      .set('content-type', 'text/plain')
      .send('x'.repeat(2_000_000));
    expect(res.status).toBe(413);
  });

  it('returns 502 when the control API rejects the key', async () => {
    const before = controlApiHits;
    const saved = process.env.INTERNAL_API_KEY;
    process.env.INTERNAL_API_KEY = 'wrong-key';
    const controlPort = (controlApi.address() as AddressInfo).port;
    const bad = await startApp({ ALLOW_PRIVATE_TARGETS: 'true', INTERNAL_API_KEY: 'wrong-key' }, controlPort);
    try {
      await request(bad.getHttpServer()).get(`/g/${GARDEN}/api/x`).expect(502);
      expect(controlApiHits).toBeGreaterThan(before);
    } finally {
      process.env.INTERNAL_API_KEY = saved;
      await bad.close();
    }
  });
});

describe('Fault proxy (e2e), SSRF protection on', () => {
  it('refuses a target on a loopback address', async () => {
    const controlPort = (controlApi.address() as AddressInfo)?.port ?? (await listen(controlApi));
    const app = await startApp({ ALLOW_PRIVATE_TARGETS: 'false' }, controlPort);
    try {
      const res = await request(app.getHttpServer()).get(`/g/${PRIVATE_GARDEN}/internal/secret`).expect(403);
      expect(res.body).toMatchObject({ error: 'target_blocked' });
    } finally {
      await app.close();
    }
  });
});
