import { matchesPath } from './glob.js';

describe('matchesPath', () => {
  it('matches literals exactly', () => {
    expect(matchesPath('/users', '/users')).toBe(true);
    expect(matchesPath('/users', '/users/1')).toBe(false);
    expect(matchesPath('/users', '/user')).toBe(false);
  });

  it('* matches any run of characters, including slashes', () => {
    expect(matchesPath('/*', '/')).toBe(true);
    expect(matchesPath('/*', '/a/b/c')).toBe(true);
    expect(matchesPath('/users/*', '/users/1/posts')).toBe(true);
    expect(matchesPath('/users/*', '/orders/1')).toBe(false);
    expect(matchesPath('/api/*/items', '/api/v1/items')).toBe(true);
  });

  it(':name matches exactly one segment', () => {
    expect(matchesPath('/users/:id', '/users/42')).toBe(true);
    expect(matchesPath('/users/:id', '/users/42/posts')).toBe(false);
    expect(matchesPath('/users/:id', '/users/')).toBe(false);
    expect(matchesPath('/users/:id/posts', '/users/42/posts')).toBe(true);
  });

  it('escapes regex characters in patterns', () => {
    expect(matchesPath('/file.json', '/file.json')).toBe(true);
    expect(matchesPath('/file.json', '/fileXjson')).toBe(false);
    expect(matchesPath('/a+b', '/a+b')).toBe(true);
    expect(matchesPath('/(x)', '/(x)')).toBe(true);
  });
});
