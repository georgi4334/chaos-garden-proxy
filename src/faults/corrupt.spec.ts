import { corruptBody } from './corrupt.js';

describe('corruptBody', () => {
  it('breaks JSON so it no longer parses', () => {
    const original = Buffer.from(JSON.stringify({ id: 1, name: 'garden', tags: ['a', 'b'] }));
    expect(() => JSON.parse(original.toString())).not.toThrow();
    const corrupted = corruptBody(original);
    expect(() => JSON.parse(corrupted.toString())).toThrow();
    expect(corrupted.equals(original)).toBe(false);
  });

  it('keeps the start of the body and handles tiny and empty bodies', () => {
    expect(corruptBody(Buffer.from('abcdefgh')).toString().startsWith('abcd')).toBe(true);
    expect(corruptBody(Buffer.from('a')).length).toBeGreaterThan(1);
    expect(corruptBody(Buffer.alloc(0)).toString()).toBe('{"chaos":');
  });
});
