import { ConfigService } from '@nestjs/config';

export const PROXY_CONFIG = Symbol('PROXY_CONFIG');
export const RANDOM = Symbol('RANDOM');

export interface ProxyConfig {
  controlApiUrl: string;
  internalApiKey: string;
  allowPrivateTargets: boolean;
  /** How long a garden's config is cached. 0 disables caching. */
  configCacheTtlMs: number;
  upstreamTimeoutMs: number;
  maxBodyBytes: number;
  /** Cap on how much of an upstream response is buffered for the corrupt fault. */
  maxCorruptBytes: number;
  /** Redis for request events. Empty disables event publishing. */
  redisUrl: string;
  eventStream: string;
  /** Approximate cap on stream length, so Redis memory stays bounded if ingest is down. */
  eventStreamMaxLen: number;
}

export function loadProxyConfig(config: ConfigService): ProxyConfig {
  const num = (key: string, fallback: number) => {
    const value = Number(config.get<string>(key) ?? fallback);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  };
  return {
    controlApiUrl: (config.get<string>('CONTROL_API_URL') ?? 'http://localhost:3000').replace(/\/+$/, ''),
    internalApiKey: config.get<string>('INTERNAL_API_KEY') ?? '',
    allowPrivateTargets: config.get<string>('ALLOW_PRIVATE_TARGETS') === 'true',
    configCacheTtlMs: num('CONFIG_CACHE_TTL_MS', 5000),
    upstreamTimeoutMs: num('UPSTREAM_TIMEOUT_MS', 10000),
    maxBodyBytes: num('MAX_BODY_BYTES', 1_048_576),
    maxCorruptBytes: num('MAX_CORRUPT_BYTES', 5_242_880),
    redisUrl: config.get<string>('REDIS_URL') ?? '',
    eventStream: config.get<string>('EVENT_STREAM') ?? 'chaos:requests',
    eventStreamMaxLen: num('EVENT_STREAM_MAXLEN', 100_000),
  };
}
