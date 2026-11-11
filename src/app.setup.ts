import { INestApplication } from '@nestjs/common';
import { httpObservabilityMiddleware } from './observability/http-observability.middleware.js';
import { initMetrics } from './observability/metrics.js';
import { requestIdMiddleware } from './observability/request-context.js';

/** Shared by main.ts and the e2e tests so both run with identical behaviour. */
export function configureApp(app: INestApplication) {
  initMetrics('proxy');
  // First: give every request an id, then time and access-log it.
  app.use(requestIdMiddleware);
  app.use(httpObservabilityMiddleware);
  // The proxy exists to be called from any frontend under test, so any origin
  // is allowed. Nothing here is credentialed (no cookies), which is what makes
  // that safe. The fault header is exposed so browser code can read it.
  app.enableCors({
    origin: '*',
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    exposedHeaders: ['x-chaos-fault', 'x-request-id', 'retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining'],
    maxAge: 600,
  });
  app.enableShutdownHooks();
}
