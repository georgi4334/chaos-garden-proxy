// Package faults holds fault behaviour that is more than a status code.
package faults

// CorruptBody keeps the first half of a body and appends junk, so JSON, HTML
// and most formats stop parsing. Deterministic, like the NestJS version.
func CorruptBody(body []byte) []byte {
	if len(body) == 0 {
		return []byte(`{"chaos":`)
	}
	cut := max(1, len(body)/2)
	out := make([]byte, 0, cut+20)
	out = append(out, body[:cut]...)
	return append(out, "\x00�<chaos-garden>"...)
}
