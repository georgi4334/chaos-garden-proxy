import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { httpDuration } from './metrics.js';

const logger = new Logger('HTTP');
/** Not timed or access-logged: scrapes and health checks would drown the real traffic. */
const QUIET_PATHS = new Set(['/metrics', '/health']);

/** Route template for metrics, e.g. "/gardens/:gardenId/targets". Unknown routes share one label. */
function routeOf(req: Request): string {
  const path = (req.route as { path?: string } | undefined)?.path;
  return path ? `${req.baseUrl}${path}` : 'unmatched';
}

/** Records an access-log line and the HTTP duration histogram when each response finishes. */
export function httpObservabilityMiddleware(req: Request, res: Response, next: NextFunction) {
  if (QUIET_PATHS.has(req.path)) return next();
  const start = process.hrtime.bigint();
  res.on('close', () => {
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    const route = routeOf(req);
    const status = res.headersSent ? res.statusCode : 0; // 0: connection closed with no response
    httpDuration.observe({ method: req.method, route, status_code: String(status) }, seconds);
    logger.log({
      msg: 'request',
      method: req.method,
      route,
      status,
      durationMs: Math.round(seconds * 1000),
      completed: res.writableFinished,
    });
  });
  next();
}
