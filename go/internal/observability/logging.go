package observability

import (
	"context"
	"io"
	"log/slog"
	"os"
)

// NewLogger returns a slog logger: one JSON object per line when format is
// "json" (for log tools), readable text otherwise. Every line carries the
// service name, and the request id when the context has one.
func NewLogger(format string) *slog.Logger { return NewLoggerTo(os.Stdout, format) }

// NewLoggerTo is NewLogger writing to w (tests pass io.Discard).
func NewLoggerTo(w io.Writer, format string) *slog.Logger {
	opts := &slog.HandlerOptions{Level: slog.LevelInfo}
	var h slog.Handler
	if format == "json" {
		h = slog.NewJSONHandler(w, opts)
	} else {
		h = slog.NewTextHandler(w, opts)
	}
	return slog.New(requestIDHandler{h}).With("service", "proxy", "impl", "go")
}

type requestIDHandler struct{ slog.Handler }

func (h requestIDHandler) Handle(ctx context.Context, r slog.Record) error {
	if id := RequestID(ctx); id != "" {
		r.AddAttrs(slog.String("requestId", id))
	}
	return h.Handler.Handle(ctx, r)
}

func (h requestIDHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return requestIDHandler{h.Handler.WithAttrs(attrs)}
}

func (h requestIDHandler) WithGroup(name string) slog.Handler {
	return requestIDHandler{h.Handler.WithGroup(name)}
}
