import dns from 'node:dns';
import { isIP } from 'node:net';

/**
 * The proxy forwards to URLs that users type in, so without these checks it
 * could be pointed at localhost, the internal network, or a cloud metadata
 * service (SSRF). Private targets are blocked unless explicitly allowed
 * (ALLOW_PRIVATE_TARGETS=true, for local development only).
 */
export function isBlockedAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isBlockedV4(address);
  if (version === 6) return isBlockedV6(address.toLowerCase());
  return true; // not an IP we understand: refuse
}

function isBlockedV4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 || // "this" network
    a === 10 || // private
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, includes cloud metadata 169.254.169.254
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) || // private
    (a === 192 && b === 0) || // IETF protocol assignments / TEST-NET-1
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast and reserved
  );
}

function isBlockedV6(ip: string): boolean {
  if (ip === '::' || ip === '::1') return true;
  // IPv4-mapped (::ffff:a.b.c.d or ::ffff:hhhh:hhhh): judge the embedded IPv4.
  const dotted = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return isBlockedV4(dotted[1]);
  const hex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return isBlockedV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  const first = parseInt(ip.split(':')[0] || '0', 16);
  return (
    (first & 0xfe00) === 0xfc00 || // unique local fc00::/7
    (first & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (first & 0xff00) === 0xff00 // multicast
  );
}

export class BlockedTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockedTargetError';
  }
}

/** Throws for non-http(s) URLs and for IP-literal hosts that are blocked. */
export function assertUrlAllowed(url: URL, allowPrivate: boolean) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedTargetError('Only http and https targets are allowed');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivate && isIP(host) && isBlockedAddress(host)) {
    throw new BlockedTargetError('Target address is not allowed');
  }
}

/**
 * A `lookup` function for http.request that checks the address actually being
 * connected to. Checking the resolved IP (not just the hostname) is what stops
 * DNS tricks, such as a public name that resolves to 127.0.0.1.
 */
export function createSafeLookup(allowPrivate: boolean): typeof dns.lookup {
  if (allowPrivate) return dns.lookup;
  const safeLookup = ((hostname: string, options: dns.LookupOptions | number, callback: (...args: any[]) => void) => {
    const opts = typeof options === 'number' ? { family: options } : { ...options };
    dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const list = addresses as dns.LookupAddress[];
      if (list.length === 0 || list.some((a) => isBlockedAddress(a.address))) {
        return callback(new BlockedTargetError('Target address is not allowed'));
      }
      if (opts.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  }) as unknown as typeof dns.lookup;
  return safeLookup;
}
