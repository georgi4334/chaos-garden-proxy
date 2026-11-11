package proxy

import "net/http"

// statusWriter records what was sent, for metrics, logs and the request event.
// Unwrap lets http.ResponseController reach the real writer (Flush, Hijack).
type statusWriter struct {
	http.ResponseWriter
	status   int // 0 until headers are sent
	writeErr bool
	hijacked bool
}

func (w *statusWriter) WriteHeader(code int) {
	if w.status == 0 {
		w.status = code
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusWriter) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	n, err := w.ResponseWriter.Write(b)
	if err != nil {
		w.writeErr = true
	}
	return n, err
}

func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// sent reports the status sent to the client, or 0 when no response was sent.
func (w *statusWriter) sent() int {
	if w.hijacked {
		return 0
	}
	return w.status
}
