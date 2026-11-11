import { Inject, Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { ControlApiClient, type TargetConfig } from '../config/control-api.client.js';
import { PROXY_CONFIG, RANDOM, type ProxyConfig } from '../config/proxy-config.js';
import { MAX_EVENT_PATH_LENGTH } from '../events/request-event.js';
import { RequestEventPublisher } from '../events/request-event.publisher.js';
import { outcomeOf, proxyRequests, rateLimitDecisions, upstreamDuration } from '../observability/proxy-metrics.js';
import { currentRequestId } from '../observability/request-context.js';
import { RateLimiter } from '../rate-limit/rate-limiter.js';
import { corruptBody } from '../faults/corrupt.js';
import { selectFaults, type Rule } from '../matching/select-faults.js';
import { assertUrlAllowed, BlockedTargetError, createSafeLookup } from '../security/ssrf.js';
import { stripHopByHop } from './headers.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** /g/<gardenId>/<targetName>[/rest][?query] */
const ROUTE_RE = /^\/g\/([^/?]+)\/([^/?]+)(\/[^?]*)?(\?.*)?$/;
const MAX_LATENCY_MS = 30_000;

@Injectable()
export class ProxyService {
  private readonly lookup: ReturnType<typeof createSafeLookup>;

  constructor(
    private readonly controlApi: ControlApiClient,
    @Inject(PROXY_CONFIG) private readonly config: ProxyConfig,
    @Inject(RANDOM) private readonly random: () => number,
    private readonly events: RequestEventPublisher,
    private readonly limiter: RateLimiter,
  ) {
    this.lookup = createSafeLookup(config.allowPrivateTargets);
  }

  async handle(req: Request, res: Response): Promise<void> {
    const startedAt = new Date();
    const started = performance.now();
    const match = ROUTE_RE.exec(req.originalUrl);
    if (!match || !UUID_RE.test(match[1])) {
      return this.sendError(req, res, 404, 'not_found', 'Unknown garden or route');
    }
    const [, gardenId, rawName, rest = '/', query = ''] = match;

    let targetName: string;
    try {
      targetName = decodeURIComponent(rawName);
    } catch {
      return this.sendError(req, res, 400, 'bad_request', 'Malformed target name');
    }

    const garden = await this.controlApi.getGardenConfig(gardenId);
    if (!garden) return this.sendError(req, res, 404, 'garden_not_found', 'Garden not found');
    const target = garden.targets.find((t) => t.name === targetName);
    if (!target) return this.sendError(req, res, 404, 'target_not_found', `No target named "${targetName}"`);

    const selection = selectFaults(target.rules, { method: req.method, path: rest }, this.random);
    const applied: string[] = [];
    const firedRuleIds: string[] = [];

    // Publish one event once the exchange is over, however it ended
    // (response sent, connection dropped, or client gone).
    const requestId = currentRequestId(); // read now: 'close' may fire outside the request's async context
    res.once('close', () => {
      const status = res.headersSent ? res.statusCode : null;
      proxyRequests.inc({ outcome: outcomeOf(applied, status) });
      this.events.publish({
        v: 1,
        id: randomUUID(),
        at: startedAt.toISOString(),
        gardenId,
        targetId: target.id,
        targetName: target.name,
        method: req.method,
        path: rest.slice(0, MAX_EVENT_PATH_LENGTH),
        status,
        completed: res.writableFinished,
        durationMs: Math.round(performance.now() - started),
        faults: [...applied],
        ruleIds: firedRuleIds,
        ...(requestId && { requestId }),
      });
    });

    // Per-garden rate limit, checked before any fault so refused requests cost nothing upstream.
    const limit = garden.rateLimit ?? this.config.defaultRateLimit;
    const decision = await this.limiter.take(gardenId, limit);
    rateLimitDecisions.inc({ decision: decision === null ? 'skipped' : decision.allowed ? 'allowed' : 'limited' });
    if (decision) {
      res.setHeader('x-ratelimit-limit', String(limit.rps));
      res.setHeader('x-ratelimit-remaining', String(decision.remaining));
    }
    if (decision && !decision.allowed) {
      applied.push('rate_limited');
      const retryAfter = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
      req.resume();
      res
        .status(429)
        .set({ 'retry-after': String(retryAfter), 'x-chaos-fault': 'rate_limited', 'content-type': 'application/json' })
        .send(
          JSON.stringify({
            error: 'rate_limited',
            message: `This garden allows ${limit.rps} requests per second (bursts up to ${limit.burst}). Slow down, or raise the limit in the dashboard.`,
            retryAfter,
          }),
        );
      return;
    }

    if (selection.latency) {
      applied.push('latency');
      firedRuleIds.push(selection.latency.id);
      const ms = clampLatency(selection.latency);
      if (!(await sleepUnlessClosed(ms, res))) return; // client went away
    }

    const terminal = selection.terminal;
    if (terminal) firedRuleIds.push(terminal.id);
    if (terminal?.type === 'drop') {
      applied.push('drop');
      req.socket.destroy(); // no response at all: the client sees a reset connection
      return;
    }
    if (terminal?.type === 'error') {
      const status = Number(terminal.params.status);
      applied.push('error');
      req.resume();
      res
        .status(Number.isInteger(status) ? status : 500)
        .set({ 'x-chaos-fault': applied.join(','), 'content-type': 'application/json' })
        .send(
          JSON.stringify({
            error: 'chaos_garden_injected_error',
            status,
            message: 'This error was injected by Chaos Garden',
          }),
        );
      return;
    }

    const corrupt = terminal?.type === 'corrupt';
    if (corrupt) applied.push('corrupt');
    await this.forward(req, res, target, rest, query, applied.join(','), corrupt);
  }

  private forward(
    req: Request,
    res: Response,
    target: TargetConfig,
    rest: string,
    query: string,
    faultHeader: string,
    corrupt: boolean,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      let base: URL;
      try {
        base = new URL(target.baseUrl);
        assertUrlAllowed(base, this.config.allowPrivateTargets);
      } catch (err) {
        const blocked = err instanceof BlockedTargetError;
        this.sendError(req, res, blocked ? 403 : 502, blocked ? 'target_blocked' : 'bad_target', blocked ? err.message : 'Target URL is invalid');
        return resolve();
      }

      const declaredLength = Number(req.headers['content-length'] ?? 0);
      if (declaredLength > this.config.maxBodyBytes) {
        req.resume();
        this.sendError(req, res, 413, 'payload_too_large', 'Request body is too large');
        return resolve();
      }

      const transport = base.protocol === 'https:' ? https : http;
      const basePath = base.pathname.replace(/\/+$/, '');
      const headers = stripHopByHop(req.headers);
      headers.host = base.host;

      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve();
      };

      const upstream = transport.request({
        protocol: base.protocol,
        hostname: base.hostname.replace(/^\[|\]$/g, ''),
        port: base.port || undefined,
        method: req.method,
        path: `${basePath}${rest}${query}`,
        headers,
        lookup: this.lookup,
      });

      const upstreamStart = process.hrtime.bigint();
      const upstreamSeconds = () => Number(process.hrtime.bigint() - upstreamStart) / 1e9;
      const timer = setTimeout(() => {
        upstream.destroy(new Error('upstream_timeout'));
      }, this.config.upstreamTimeoutMs);

      upstream.on('response', (up) => {
        upstreamDuration.observe({ result: 'response' }, upstreamSeconds());
        const outHeaders = stripHopByHop(up.headers);
        if (faultHeader) outHeaders['x-chaos-fault'] = faultHeader;
        const status = up.statusCode ?? 502;

        if (!corrupt) {
          res.writeHead(status, outHeaders);
          up.pipe(res);
          up.on('end', done);
          up.on('error', () => {
            res.destroy();
            done();
          });
          return;
        }

        // corrupt: buffer (up to a cap), garble, send
        const chunks: Buffer[] = [];
        let size = 0;
        up.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > this.config.maxCorruptBytes) return up.destroy();
          chunks.push(chunk);
        });
        const finish = () => {
          if (res.headersSent) return done();
          const body = corruptBody(Buffer.concat(chunks));
          outHeaders['content-length'] = body.length;
          res.writeHead(status, outHeaders);
          res.end(body);
          done();
        };
        up.on('end', finish);
        up.on('close', finish);
        up.on('error', () => undefined);
      });

      upstream.on('error', (err: NodeJS.ErrnoException) => {
        const result =
          err instanceof BlockedTargetError ? 'blocked' : err.message === 'upstream_timeout' ? 'timeout' : 'error';
        if (!res.headersSent) upstreamDuration.observe({ result }, upstreamSeconds());
        if (res.headersSent) {
          res.destroy();
        } else if (err instanceof BlockedTargetError) {
          this.sendError(req, res, 403, 'target_blocked', err.message);
        } else if (err.message === 'upstream_timeout') {
          this.sendError(req, res, 504, 'upstream_timeout', 'The target did not respond in time');
        } else {
          this.sendError(req, res, 502, 'upstream_unreachable', 'Could not reach the target');
        }
        done();
      });

      res.on('close', () => {
        if (!res.writableFinished) upstream.destroy();
        done();
      });

      // Stream the request body to the target, enforcing the size cap.
      let received = 0;
      req.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > this.config.maxBodyBytes && !res.headersSent) {
          upstream.destroy();
          this.sendError(req, res, 413, 'payload_too_large', 'Request body is too large');
          done();
        }
      });
      req.pipe(upstream);
    });
  }

  private sendError(req: Request, res: Response, status: number, code: string, message: string): void {
    if (res.headersSent) return;
    req.resume();
    res.status(status).set('content-type', 'application/json').send(JSON.stringify({ error: code, message }));
  }
}

function clampLatency(rule: Rule): number {
  const ms = Number(rule.params.ms);
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return Math.min(ms, MAX_LATENCY_MS);
}

/** Waits `ms`; resolves false (and stops waiting) if the client disconnects first. */
function sleepUnlessClosed(ms: number, res: Response): Promise<boolean> {
  return new Promise((resolve) => {
    const onClose = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      res.off('close', onClose);
      resolve(true);
    }, ms);
    res.once('close', onClose);
  });
}
