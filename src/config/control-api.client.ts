import { BadGatewayException, Inject, Injectable } from '@nestjs/common';
import { configLookups } from '../observability/proxy-metrics.js';
import { currentRequestId, REQUEST_ID_HEADER } from '../observability/request-context.js';
import { PROXY_CONFIG, type ProxyConfig } from './proxy-config.js';
import type { Rule } from '../matching/select-faults.js';

export interface TargetConfig {
  id: string;
  name: string;
  baseUrl: string;
  rules: Rule[];
}

export interface GardenConfig {
  gardenId: string;
  /** Token bucket for this garden. Older control APIs don't send it; the proxy default applies. */
  rateLimit?: { rps: number; burst: number };
  targets: TargetConfig[];
}

interface CacheEntry {
  expiresAt: number;
  value: GardenConfig | null;
}

/** Reads a garden's targets and rules from the control API, with a short in-memory cache. */
@Injectable()
export class ControlApiClient {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(@Inject(PROXY_CONFIG) private readonly config: ProxyConfig) {}

  /** Returns null when the garden does not exist. Throws 502 if the control API is unreachable. */
  async getGardenConfig(gardenId: string): Promise<GardenConfig | null> {
    const now = Date.now();
    const cached = this.cache.get(gardenId);
    if (cached && cached.expiresAt > now) {
      configLookups.inc({ result: 'hit' });
      return cached.value;
    }

    let response: Response;
    try {
      response = await fetch(`${this.config.controlApiUrl}/internal/gardens/${gardenId}/config`, {
        headers: {
          'x-internal-key': this.config.internalApiKey,
          [REQUEST_ID_HEADER]: currentRequestId() ?? '',
        },
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      configLookups.inc({ result: 'error' });
      throw new BadGatewayException('Control API unreachable');
    }

    let value: GardenConfig | null;
    if (response.status === 404) {
      configLookups.inc({ result: 'not_found' });
      value = null;
    } else if (response.ok) {
      configLookups.inc({ result: 'fetched' });
      value = (await response.json()) as GardenConfig;
    } else {
      configLookups.inc({ result: 'error' });
      throw new BadGatewayException(`Control API returned ${response.status}`);
    }

    if (this.config.configCacheTtlMs > 0) {
      this.cache.set(gardenId, { value, expiresAt: now + this.config.configCacheTtlMs });
      if (this.cache.size > 1000) this.evictExpired(now);
    }
    return value;
  }

  private evictExpired(now: number) {
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) this.cache.delete(key);
    }
  }
}
