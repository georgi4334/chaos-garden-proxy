// Package matching decides which fault rules apply to a request.
package matching

import (
	"regexp"
	"strings"
	"sync"
)

var cache sync.Map // pattern -> *regexp.Regexp

// Compile turns a rule's path pattern into a regular expression:
//   - `*` matches any run of characters (including `/`)
//   - `:name` matches exactly one path segment
//   - everything else is literal
//
// Same rules as the NestJS proxy (src/matching/glob.ts).
func Compile(pattern string) *regexp.Regexp {
	if re, ok := cache.Load(pattern); ok {
		return re.(*regexp.Regexp)
	}
	var b strings.Builder
	b.WriteString("^")
	literal := strings.Builder{}
	flush := func() {
		b.WriteString(regexp.QuoteMeta(literal.String()))
		literal.Reset()
	}
	for i := 0; i < len(pattern); i++ {
		c := pattern[i]
		switch {
		case c == '*':
			flush()
			b.WriteString(".*")
		case c == ':' && i+1 < len(pattern) && isIdentStart(pattern[i+1]):
			flush()
			j := i + 1
			for j < len(pattern) && isIdent(pattern[j]) {
				j++
			}
			b.WriteString("[^/]+")
			i = j - 1
		default:
			literal.WriteByte(c)
		}
	}
	flush()
	b.WriteString("$")
	re := regexp.MustCompile(b.String())
	cache.Store(pattern, re)
	return re
}

// MatchesPath reports whether path matches the rule pattern.
func MatchesPath(pattern, path string) bool { return Compile(pattern).MatchString(path) }

func isIdentStart(c byte) bool { return c == '_' || (c|0x20 >= 'a' && c|0x20 <= 'z') }
func isIdent(c byte) bool      { return isIdentStart(c) || (c >= '0' && c <= '9') }
