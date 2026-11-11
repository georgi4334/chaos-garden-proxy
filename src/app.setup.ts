import { INestApplication } from '@nestjs/common';

/** Shared by main.ts and the e2e tests so both run with identical behaviour. */
export function configureApp(app: INestApplication) {
  // The proxy exists to be called from any frontend under test, so any origin
  // is allowed. Nothing here is credentialed (no cookies), which is what makes
  // that safe. The fault header is exposed so browser code can read it.
  app.enableCors({
    origin: '*',
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    exposedHeaders: ['x-chaos-fault', 'retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining'],
    maxAge: 600,
  });
  app.enableShutdownHooks();
}
