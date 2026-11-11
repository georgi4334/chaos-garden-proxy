import { Counter, Histogram } from 'prom-client';
import { registry } from './metrics.js';

/** Proxy-specific metrics. Labels are small fixed sets; never garden ids or paths. */
export const proxyRequests = new Counter({
  name: 'chaos_proxy_requests_total',
  help: 'Proxied requests by outcome (ok, slow, error, drop, corrupt, target_error, no_response, rate_limited)',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

export const upstreamDuration = new Histogram({
  name: 'chaos_proxy_upstream_seconds',
  help: 'Time from sending a request to the target until its response headers (or failure)',
  labelNames: ['result'] as const, // response | error | timeout | blocked
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const rateLimitDecisions = new Counter({
  name: 'chaos_proxy_rate_limit_decisions_total',
  help: 'Rate limit checks: allowed, limited, or skipped (Redis unavailable or limiting off)',
  labelNames: ['decision'] as const,
  registers: [registry],
});

export const configLookups = new Counter({
  name: 'chaos_proxy_config_lookups_total',
  help: 'Garden config lookups: cache hit, fetched from the control API, not found, or error',
  labelNames: ['result'] as const,
  registers: [registry],
});

export const eventsPublished = new Counter({
  name: 'chaos_proxy_events_total',
  help: 'Request events for the ingest service: sent to Redis, or dropped',
  labelNames: ['result'] as const,
  registers: [registry],
});

/** Same rules as the ingest service's classify(), so metrics and logs agree. */
export function outcomeOf(faults: string[], status: number | null): string {
  if (faults.includes('rate_limited')) return 'rate_limited';
  if (faults.includes('drop')) return 'drop';
  if (faults.includes('error')) return 'error';
  if (status === null) return 'no_response';
  if (faults.includes('corrupt')) return 'corrupt';
  if (status >= 400) return 'target_error';
  if (faults.includes('latency')) return 'slow';
  return 'ok';
}
