import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../events/request-event.publisher.js';

/**
 * Token bucket, run inside Redis so that refilling and taking a token is one
 * atomic step, and every proxy instance shares the same bucket per garden.
 *
 * The bucket holds up to `burst` tokens and refills at `rate` tokens per second.
 * Each request takes one; with none left, the request is refused and the
 * script says how long until the next token.
 *
 * KEYS[1] = bucket key; ARGV = rate, burst, now (ms), cost
 * Returns { allowed (1/0), tokens left (string, keeps decimals), retry after (ms) }
 */
const TOKEN_BUCKET_LUA = `
local rate = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])

local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts = tonumber(state[2])
if tokens == nil then
  tokens = burst
  ts = now
end
if now > ts then
  tokens = math.min(burst, tokens + (now - ts) * rate / 1000)
  ts = now
end

local allowed = 0
local retry_ms = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  retry_ms = math.ceil((cost - tokens) * 1000 / rate)
end

redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', ts)
-- Forget the bucket once it would be full again anyway.
redis.call('PEXPIRE', KEYS[1], math.ceil(burst * 1000 / rate) + 1000)
return { allowed, tostring(tokens), retry_ms }
`;

export interface RateLimit {
  rps: number;
  burst: number;
}

export interface Decision {
  allowed: boolean;
  /** Whole tokens left after this request. */
  remaining: number;
  /** When refused: how long until a token is available. */
  retryAfterMs: number;
}

type TakeToken = (key: string, rate: number, burst: number, now: number, cost: number) => Promise<[number, string, number]>;

const WARN_EVERY_MS = 30_000;

@Injectable()
export class RateLimiter {
  private readonly logger = new Logger(RateLimiter.name);
  private lastWarnAt = 0;
  private readonly takeToken: TakeToken | null;

  constructor(@Inject(REDIS_CLIENT) redis: Redis | null) {
    if (redis) {
      // defineCommand sends the script once and then calls it by its SHA (EVALSHA).
      redis.defineCommand('chaosTakeToken', { numberOfKeys: 1, lua: TOKEN_BUCKET_LUA });
      const command = (redis as unknown as { chaosTakeToken: TakeToken }).chaosTakeToken.bind(redis);
      this.takeToken = command;
    } else {
      this.takeToken = null;
    }
  }

  get enabled(): boolean {
    return this.takeToken !== null;
  }

  /**
   * Takes one token for the garden. Returns null when limiting is off or Redis
   * is unavailable: the proxy then lets the request through (fail open), so a
   * Redis outage never takes everyone's traffic down with it.
   */
  async take(gardenId: string, limit: RateLimit, now = Date.now()): Promise<Decision | null> {
    if (!this.takeToken) return null;
    try {
      const [allowed, tokens, retryMs] = await this.takeToken(
        `chaos:ratelimit:garden:${gardenId}`,
        limit.rps,
        limit.burst,
        now,
        1,
      );
      return { allowed: allowed === 1, remaining: Math.floor(Number(tokens)), retryAfterMs: Number(retryMs) };
    } catch (err) {
      const t = Date.now();
      if (t - this.lastWarnAt >= WARN_EVERY_MS) {
        this.lastWarnAt = t;
        this.logger.warn(`Rate limiting skipped, Redis unavailable: ${(err as Error).message}`);
      }
      return null;
    }
  }
}
