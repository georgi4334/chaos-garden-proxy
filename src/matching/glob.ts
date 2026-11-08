/**
 * Path patterns used by fault rules:
 *  - `*`      matches any run of characters (including `/`)
 *  - `:name`  matches exactly one path segment
 *  - anything else is literal
 * Examples: `/users/*` matches `/users/1` and `/users/1/posts`; `/users/:id`
 * matches `/users/1` only.
 */
export function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      source += '.*';
    } else if (ch === ':' && /[A-Za-z_]/.test(pattern[i + 1] ?? '')) {
      let j = i + 1;
      while (j < pattern.length && /\w/.test(pattern[j])) j++;
      source += '[^/]+';
      i = j - 1;
    } else {
      source += ch.replace(/[.+?^${}()|[\]\\\-/]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

export function matchesPath(pattern: string, path: string): boolean {
  return globToRegExp(pattern).test(path);
}
