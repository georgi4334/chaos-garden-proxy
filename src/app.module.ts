import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { ControlApiClient } from './config/control-api.client.js';
import { loadProxyConfig, PROXY_CONFIG, RANDOM, type ProxyConfig } from './config/proxy-config.js';
import { REDIS_CLIENT, RequestEventPublisher } from './events/request-event.publisher.js';
import { HealthController } from './health/health.controller.js';
import { RateLimiter } from './rate-limit/rate-limiter.js';
import { ProxyController } from './proxy/proxy.controller.js';
import { ProxyService } from './proxy/proxy.service.js';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  controllers: [HealthController, ProxyController],
  providers: [
    {
      provide: PROXY_CONFIG,
      inject: [ConfigService],
      useFactory: loadProxyConfig,
    },
    // Injectable so tests can make probability decisions deterministic.
    { provide: RANDOM, useValue: Math.random },
    {
      provide: REDIS_CLIENT,
      inject: [PROXY_CONFIG],
      useFactory: (config: ProxyConfig) =>
        config.redisUrl
          ? new Redis(config.redisUrl, {
              // Fail fast instead of queueing: events are best-effort.
              enableOfflineQueue: false,
              maxRetriesPerRequest: 1,
              connectTimeout: 2000,
              // A slow Redis must not slow requests down: give up quickly (and fail open).
              commandTimeout: 250,
            })
          : null,
    },
    RequestEventPublisher,
    {
      provide: RateLimiter,
      inject: [REDIS_CLIENT, PROXY_CONFIG],
      useFactory: (redis: Redis | null, config: ProxyConfig) => new RateLimiter(config.rateLimitEnabled ? redis : null),
    },
    ControlApiClient,
    ProxyService,
  ],
})
export class AppModule {}
