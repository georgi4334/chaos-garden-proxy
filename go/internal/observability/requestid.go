// Package observability: request ids, structured logs and Prometheus metrics,
// matching the NestJS services so logs and dashboards work the same.
package observability

import (
	"context"
	"crypto/rand"
	"fmt"
	"net/http"
	"regexp"
)

const RequestIDHeader = "X-Request-Id"

var validID = regexp.MustCompile(`^[A-Za-z0-9._:-]{8,128}$`)

type ctxKey struct{}

// RequestID returns the request id stored in ctx, or "".
func RequestID(ctx context.Context) string {
	id, _ := ctx.Value(ctxKey{}).(string)
	return id
}

// WithRequestID stores id in ctx.
func WithRequestID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, ctxKey{}, id)
}

// PickRequestID keeps a caller's id when it is short and plain, else makes a UUID v4.
func PickRequestID(incoming string) string {
	if validID.MatchString(incoming) {
		return incoming
	}
	return newUUID()
}

func newUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// RequestIDMiddleware gives every request an id (keeping a valid incoming one),
// echoes it on the response, sets it on the request headers (so it is
// forwarded to the target) and in the context (for logs and outgoing calls).
func RequestIDMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := PickRequestID(r.Header.Get(RequestIDHeader))
		r.Header.Set(RequestIDHeader, id)
		w.Header().Set(RequestIDHeader, id)
		next.ServeHTTP(w, r.WithContext(WithRequestID(r.Context(), id)))
	})
}
