import { assertUrlAllowed, BlockedTargetError, isBlockedAddress } from './ssrf.js';

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1',
    '127.8.8.8',
    '0.0.0.0',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '100.64.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1', // 127.0.0.1 in hex form
    '::ffff:a9fe:a9fe', // 169.254.169.254 in hex form
    'not-an-ip',
  ])('blocks %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '93.184.216.34', '2606:4700:4700::1111'])(
    'allows public address %s',
    (ip) => {
      expect(isBlockedAddress(ip)).toBe(false);
    },
  );
});

describe('assertUrlAllowed', () => {
  it('rejects non-http schemes', () => {
    expect(() => assertUrlAllowed(new URL('file:///etc/passwd'), true)).toThrow(BlockedTargetError);
    expect(() => assertUrlAllowed(new URL('ftp://example.com'), true)).toThrow(BlockedTargetError);
  });

  it('rejects private IP literals unless private targets are allowed', () => {
    expect(() => assertUrlAllowed(new URL('http://127.0.0.1:4000'), false)).toThrow(BlockedTargetError);
    expect(() => assertUrlAllowed(new URL('http://[::1]:4000'), false)).toThrow(BlockedTargetError);
    expect(() => assertUrlAllowed(new URL('http://169.254.169.254/latest'), false)).toThrow(BlockedTargetError);
    expect(() => assertUrlAllowed(new URL('http://127.0.0.1:4000'), true)).not.toThrow();
  });

  it('allows public hosts (hostnames are checked at connect time)', () => {
    expect(() => assertUrlAllowed(new URL('https://api.example.com'), false)).not.toThrow();
    expect(() => assertUrlAllowed(new URL('http://8.8.8.8'), false)).not.toThrow();
  });
});
