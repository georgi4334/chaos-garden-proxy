import { Controller, Get, Header, Headers, UnauthorizedException } from '@nestjs/common';
import { registry } from './metrics.js';

/**
 * Prometheus scrape endpoint. Open by default (expose it on an internal network
 * only); set METRICS_TOKEN to require `Authorization: Bearer <token>`.
 */
@Controller('metrics')
export class MetricsController {
  @Get()
  @Header('content-type', registry.contentType)
  async metrics(@Headers('authorization') authorization?: string) {
    const token = process.env.METRICS_TOKEN;
    if (token && authorization !== `Bearer ${token}`) throw new UnauthorizedException();
    return registry.metrics();
  }
}
