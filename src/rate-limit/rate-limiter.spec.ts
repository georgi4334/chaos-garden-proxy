import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { RateLimiter } from './rate-limiter.js';

describe('RateLimiter without Redis', () => {
  it('is disabled and lets everything through (returns null)', async () => {
    const limiter = new RateLimiter(null);
    expect(limiter.enabled).toBe(false);
    expect(await limiter.take('g', { rps: 1, burst: 1 })).toBeNull();
  });

  it('fails open when Redis errors, without throwing', async () => {
    const fake = {
      defineCommand(name: string) {
        (this as Record<string, unknown>)[name] = () => Promise.reject(new Error('Connection is closed.'));
      },
    };
    const limiter = new RateLimiter(fake as unknown as Redis);
    await expect(limiter.take('g', { rps: 1, burst: 1 })).resolves.toBeNull();
  });
});

// Runs against a real Redis when REDIS_URL is set (e.g. redis://localhost:6379).
describe.skipIf(!process.env.REDIS_URL)('RateLimiter with real Redis', () => {
  let redis: Redis;
  let limiter: RateLimiter;

  beforeAll(() => {
    redis = new Redis(process.env.REDIS_URL!);
    limiter = new RateLimiter(redis);
  });
  afterAll(async () => {
    await redis.quit();
  });

  it('allows a burst, then refuses with the time until the next token', async () => {
    const garden = randomUUID();
    const limit = { rps: 2, burst: 3 };
    const t0 = 1_000_000;
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await limiter.take(garden, limit, t0));
    expect(results.map((r) => r!.allowed)).toEqual([true, true, true, false]);
    expect(results.map((r) => r!.remaining)).toEqual([2, 1, 0, 0]);
    expect(results[3]!.retryAfterMs).toBe(500); // one token at 2 per second
  });

  it('refills at the configured rate, never above the burst', async () => {
    const garden = randomUUID();
    const limit = { rps: 2, burst: 3 };
    const t0 = 2_000_000;
    for (let i = 0; i < 3; i++) await limiter.take(garden, limit, t0);
    expect((await limiter.take(garden, limit, t0 + 499))!.allowed).toBe(false); // 0.998 tokens
    expect((await limiter.take(garden, limit, t0 + 1000))!.allowed).toBe(true); // ~2 tokens, took 1
    // a long pause refills only up to the burst
    const later = await limiter.take(garden, limit, t0 + 60_000);
    expect(later).toMatchObject({ allowed: true, remaining: 2 });
  });

  it('keeps each garden in its own bucket', async () => {
    const limit = { rps: 1, burst: 1 };
    const a = randomUUID();
    const b = randomUUID();
    expect((await limiter.take(a, limit, 5_000_000))!.allowed).toBe(true);
    expect((await limiter.take(a, limit, 5_000_000))!.allowed).toBe(false);
    expect((await limiter.take(b, limit, 5_000_000))!.allowed).toBe(true);
  });

  it('is atomic: 50 concurrent requests on a burst of 20 let exactly 20 through', async () => {
    const garden = randomUUID();
    const decisions = await Promise.all(
      Array.from({ length: 50 }, () => limiter.take(garden, { rps: 1, burst: 20 }, 9_000_000)),
    );
    expect(decisions.filter((d) => d!.allowed)).toHaveLength(20);
  });

  it('lets the bucket key expire once it would be full again', async () => {
    const garden = randomUUID();
    await limiter.take(garden, { rps: 10, burst: 5 }, Date.now());
    const ttl = await redis.pttl(`chaos:ratelimit:garden:${garden}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(1500); // 5 tokens / 10 per second = 500 ms, plus 1 s
  });
});
