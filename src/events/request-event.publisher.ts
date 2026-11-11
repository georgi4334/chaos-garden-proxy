import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { PROXY_CONFIG, type ProxyConfig } from '../config/proxy-config.js';
import { eventsPublished } from '../observability/proxy-metrics.js';
import type { RequestEventV1 } from './request-event.js';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');
const WARN_EVERY_MS = 30_000;

/**
 * Publishes request events to a Redis Stream, fire-and-forget.
 *
 * Logging must never slow down or break the proxy, so publish() returns
 * immediately and failures only increment a counter. The Redis client is
 * created with its offline queue disabled: while Redis is down, events are
 * dropped instead of piling up in memory.
 */
@Injectable()
export class RequestEventPublisher implements OnApplicationShutdown {
  private readonly logger = new Logger(RequestEventPublisher.name);
  private droppedCount = 0;
  private lastWarnAt = 0;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis | null,
    @Inject(PROXY_CONFIG) private readonly config: ProxyConfig,
  ) {
    this.redis?.on('error', (err: Error) => this.warn(`Redis error: ${err.message}`));
  }

  get dropped(): number {
    return this.droppedCount;
  }

  publish(event: RequestEventV1): void {
    if (!this.redis) return; // events disabled (REDIS_URL not set)
    this.redis
      .xadd(
        this.config.eventStream,
        'MAXLEN',
        '~',
        String(this.config.eventStreamMaxLen),
        '*',
        'data',
        JSON.stringify(event),
      )
      .then(() => eventsPublished.inc({ result: 'sent' }))
      .catch((err: Error) => {
        eventsPublished.inc({ result: 'dropped' });
        this.droppedCount++;
        this.warn(`Dropped request event: ${err.message} (${this.droppedCount} dropped so far)`);
      });
  }

  async onApplicationShutdown() {
    if (!this.redis) return;
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }

  /** Rate-limited, so a Redis outage doesn't flood the logs. */
  private warn(message: string) {
    const now = Date.now();
    if (now - this.lastWarnAt < WARN_EVERY_MS) return;
    this.lastWarnAt = now;
    this.logger.warn(message);
  }
}
