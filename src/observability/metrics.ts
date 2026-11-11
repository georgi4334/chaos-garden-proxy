import { collectDefaultMetrics, Histogram, Registry } from 'prom-client';

/**
 * One registry per service. Every metric carries a `service` label, so one
 * Prometheus can scrape all services and dashboards can split by service.
 */
export const registry = new Registry();

let initialised = false;
export function initMetrics(service: string) {
  if (initialised) return;
  initialised = true;
  registry.setDefaultLabels({ service });
  collectDefaultMetrics({ register: registry }); // CPU, memory, event loop lag, GC
}

/**
 * The RED method for every HTTP route: Rate (count), Errors (status_code),
 * Duration (buckets). `route` is the route template (e.g. /gardens/:gardenId),
 * never the raw URL, so the number of label values stays small.
 */
export const httpDuration = new Histogram({
  name: 'http_server_requests_seconds',
  help: 'HTTP requests handled by this service, by route template and status',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [registry],
});
