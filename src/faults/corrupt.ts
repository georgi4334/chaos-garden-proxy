/**
 * Makes a response body malformed: keeps the first half, then appends junk.
 * JSON, HTML and most other formats stop parsing, which is exactly what a
 * frontend should be tested against. Deterministic, so it is easy to test.
 */
export function corruptBody(body: Buffer): Buffer {
  if (body.length === 0) return Buffer.from('{"chaos":');
  const cut = Math.max(1, Math.floor(body.length / 2));
  return Buffer.concat([body.subarray(0, cut), Buffer.from('\u0000�<chaos-garden>')]);
}
