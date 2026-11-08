import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';

/** Headers that describe one network hop and must not be forwarded (RFC 9110 / 7230). */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Copies headers, dropping hop-by-hop ones and any header named in `Connection`. */
export function stripHopByHop(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const named = String(headers.connection ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || named.includes(lower)) continue;
    out[lower] = value;
  }
  return out;
}
