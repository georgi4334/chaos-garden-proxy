import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ControlApiClient } from './config/control-api.client.js';
import { loadProxyConfig, PROXY_CONFIG, RANDOM } from './config/proxy-config.js';
import { HealthController } from './health/health.controller.js';
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
    ControlApiClient,
    ProxyService,
  ],
})
export class AppModule {}
