// Package proxy is the fault-injecting reverse proxy: same behaviour, URLs and
// headers as the NestJS proxy (src/proxy/proxy.service.ts).
package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"log/slog"
	"math"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/georgi4334/chaos-garden-proxy/go/internal/config"
	"github.com/georgi4334/chaos-garden-proxy/go/internal/controlapi"
	"github.com/georgi4334/chaos-garden-proxy/go/internal/events"
	"github.com/georgi4334/chaos-garden-proxy/go/internal/faults"
	"github.com/georgi4334/chaos-garden-proxy/go/internal/matching"
	"github.com/georgi4334/chaos-garden-proxy/go/internal/observability"
	"github.com/georgi4334/chaos-garden-proxy/go/internal/ratelimit"
	"github.com/georgi4334/chaos-garden-proxy/go/internal/ssrf"
)

const (
	maxLatency     = 30 * time.Second
	maxEventPath   = 512
	exposedHeaders = "x-chaos-fault, x-request-id, retry-after, x-ratelimit-limit, x-ratelimit-remaining"
)

var (
	routeRe = regexp.MustCompile(`^/g/([^/]+)/([^/]+)(/.*)?$`)
	uuidRe  = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
)

// GardenSource is the control API client (a fake in tests).
type GardenSource interface {
	Garden(ctx context.Context, gardenID string) (*controlapi.GardenConfig, error)
}

type Options struct {
	Config  config.Config
	Gardens GardenSource
	Events  events.Publisher
	Limiter *ratelimit.Limiter
	Metrics *observability.Metrics
	Log     *slog.Logger
	Random  func() float64
}

type Server struct {
	Options
	transport *http.Transport
}

func New(o Options) *Server {
	dialer := &net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}
	if !o.Config.AllowPrivateTargets {
		dialer.Control = ssrf.DialControl // checks the address actually connected to
	}
	return &Server{Options: o, transport: &http.Transport{
		DialContext:         dialer.DialContext,
		MaxIdleConns:        512,
		MaxIdleConnsPerHost: 128,
		IdleConnTimeout:     90 * time.Second,
	}}
}

// Handler is the whole HTTP surface: /health, /metrics and /g/... with CORS,
// request ids, access logs and HTTP metrics.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	metrics := promhttp.HandlerFor(s.Metrics.Registry, promhttp.HandlerOpts{})
	mux.HandleFunc("GET /metrics", func(w http.ResponseWriter, r *http.Request) {
		if t := s.Config.MetricsToken; t != "" && r.Header.Get("Authorization") != "Bearer "+t {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"statusCode": 401, "message": "Unauthorized"})
			return
		}
		metrics.ServeHTTP(w, r)
	})
	mux.HandleFunc("/g/", s.proxy)
	return cors(observability.RequestIDMiddleware(s.observe(mux)))
}

// routeOf returns the route template for metrics (bounded label values), or "" for quiet paths.
func routeOf(path string) string {
	switch {
	case path == "/health" || path == "/metrics":
		return ""
	case routeRe.MatchString(path):
		if m := routeRe.FindStringSubmatch(path); m[3] == "" {
			return "/g/:gardenId/:targetName"
		}
		return "/g/:gardenId/:targetName/*path"
	default:
		return "unmatched"
	}
}

func (s *Server) observe(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		route := routeOf(r.URL.Path)
		if route == "" {
			next.ServeHTTP(w, r)
			return
		}
		sw := &statusWriter{ResponseWriter: w}
		start := time.Now()
		defer func() {
			d := time.Since(start)
			status := sw.sent()
			s.Metrics.HTTPDuration.WithLabelValues(r.Method, route, strconv.Itoa(status)).Observe(d.Seconds())
			s.Log.InfoContext(r.Context(), "request", "context", "HTTP", "method", r.Method, "route", route,
				"status", status, "durationMs", d.Milliseconds(), "completed", status != 0 && !sw.writeErr)
		}()
		next.ServeHTTP(sw, r)
	})
}

// cors: the proxy is called from any frontend under test, and nothing is credentialed.
func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", "*")
		h.Set("Access-Control-Expose-Headers", exposedHeaders)
		if r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != "" {
			h.Set("Access-Control-Allow-Methods", "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS")
			if req := r.Header.Get("Access-Control-Request-Headers"); req != "" {
				h.Set("Access-Control-Allow-Headers", req)
				h.Add("Vary", "Access-Control-Request-Headers")
			}
			h.Set("Access-Control-Max-Age", "600")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) proxy(rw http.ResponseWriter, r *http.Request) {
	startedAt := time.Now()
	w := &statusWriter{ResponseWriter: rw}

	m := routeRe.FindStringSubmatch(r.URL.EscapedPath())
	if m == nil || !uuidRe.MatchString(m[1]) {
		jsonError(w, http.StatusNotFound, "not_found", "Unknown garden or route")
		return
	}
	gardenID, rest := m[1], m[3]
	if rest == "" {
		rest = "/"
	}
	targetName, err := url.PathUnescape(m[2])
	if err != nil {
		jsonError(w, http.StatusBadRequest, "bad_request", "Malformed target name")
		return
	}

	garden, err := s.Gardens.Garden(r.Context(), gardenID)
	if err != nil {
		jsonError(w, http.StatusBadGateway, "control_api_unavailable", "Control API unreachable")
		return
	}
	if garden == nil {
		jsonError(w, http.StatusNotFound, "garden_not_found", "Garden not found")
		return
	}
	var target *controlapi.Target
	for i := range garden.Targets {
		if garden.Targets[i].Name == targetName {
			target = &garden.Targets[i]
			break
		}
	}
	if target == nil {
		jsonError(w, http.StatusNotFound, "target_not_found", fmt.Sprintf("No target named %q", targetName))
		return
	}

	sel := matching.Select(target.Rules, r.Method, rest, s.Random)
	applied := []string{}
	fired := []string{}

	// One event once the exchange is over, however it ended.
	defer func() {
		sent := w.sent()
		s.Metrics.Requests.WithLabelValues(observability.OutcomeOf(applied, sent)).Inc()
		e := events.Event{
			V: 1, ID: observability.PickRequestID(""), At: startedAt.UTC().Format("2006-01-02T15:04:05.000Z07:00"),
			GardenID: gardenID, TargetID: target.ID, TargetName: target.Name, Method: r.Method,
			Path: truncate(rest, maxEventPath), Completed: sent != 0 && !w.writeErr && r.Context().Err() == nil,
			DurationMs: time.Since(startedAt).Milliseconds(), Faults: applied, RuleIDs: fired,
			RequestID: observability.RequestID(r.Context()),
		}
		if sent != 0 {
			e.Status = &sent
		}
		s.Events.Publish(e)
	}()

	// Per-garden rate limit, before any fault so refused requests cost nothing upstream.
	rps, burst := s.Config.DefaultRateLimitRPS, s.Config.DefaultRateLimitBurst
	if garden.RateLimit != nil {
		rps, burst = garden.RateLimit.RPS, garden.RateLimit.Burst
	}
	decision := s.Limiter.Take(r.Context(), gardenID, rps, burst, time.Now())
	switch {
	case decision == nil:
		s.Metrics.RateLimitDecision.WithLabelValues("skipped").Inc()
	case decision.Allowed:
		s.Metrics.RateLimitDecision.WithLabelValues("allowed").Inc()
	default:
		s.Metrics.RateLimitDecision.WithLabelValues("limited").Inc()
	}
	if decision != nil {
		w.Header().Set("X-Ratelimit-Limit", strconv.FormatFloat(rps, 'f', -1, 64))
		w.Header().Set("X-Ratelimit-Remaining", strconv.Itoa(decision.Remaining))
		if !decision.Allowed {
			applied = append(applied, "rate_limited")
			retryAfter := int(math.Max(1, math.Ceil(decision.RetryAfter.Seconds())))
			w.Header().Set("Retry-After", strconv.Itoa(retryAfter))
			w.Header().Set("X-Chaos-Fault", "rate_limited")
			writeJSON(w, http.StatusTooManyRequests, map[string]any{
				"error":      "rate_limited",
				"message":    fmt.Sprintf("This garden allows %s requests per second (bursts up to %s). Slow down, or raise the limit in the dashboard.", fmtNum(rps), fmtNum(burst)),
				"retryAfter": retryAfter,
			})
			return
		}
	}

	if sel.Latency != nil {
		applied = append(applied, "latency")
		fired = append(fired, sel.Latency.ID)
		select {
		case <-time.After(latencyOf(sel.Latency)):
		case <-r.Context().Done():
			return // client went away
		}
	}

	corrupt := false
	if t := sel.Terminal; t != nil {
		fired = append(fired, t.ID)
		switch t.Type {
		case "drop":
			applied = append(applied, "drop")
			drop(w)
			return
		case "error":
			applied = append(applied, "error")
			status := intParam(t.Params, "status", 500)
			w.Header().Set("X-Chaos-Fault", strings.Join(applied, ","))
			writeJSON(w, status, map[string]any{
				"error": "chaos_garden_injected_error", "status": status, "message": "This error was injected by Chaos Garden",
			})
			return
		case "corrupt":
			applied = append(applied, "corrupt")
			corrupt = true
		}
	}

	s.forward(w, r, target, rest, applied, corrupt)
}

func (s *Server) forward(w *statusWriter, r *http.Request, target *controlapi.Target, rest string, applied []string, corrupt bool) {
	base, err := url.Parse(target.BaseURL)
	if err != nil {
		jsonError(w, http.StatusBadGateway, "bad_target", "Target URL is invalid")
		return
	}
	if err := ssrf.CheckURL(base); err != nil {
		jsonError(w, http.StatusForbidden, "target_blocked", err.Error())
		return
	}
	if r.ContentLength > s.Config.MaxBodyBytes {
		jsonError(w, http.StatusRequestEntityTooLarge, "payload_too_large", "Request body is too large")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, s.Config.MaxBodyBytes)

	ctx, cancel := context.WithTimeout(r.Context(), s.Config.UpstreamTimeout)
	defer cancel()
	upstreamStart := time.Now()
	faultHeader := strings.Join(applied, ",")

	rp := &httputil.ReverseProxy{
		Transport: s.transport,
		ErrorLog:  log.New(io.Discard, "", 0), // handled in ErrorHandler
		Rewrite: func(pr *httputil.ProxyRequest) {
			escaped := strings.TrimRight(base.EscapedPath(), "/") + rest
			path, _ := url.PathUnescape(escaped)
			pr.Out.URL.Scheme, pr.Out.URL.Host = base.Scheme, base.Host
			pr.Out.URL.Path, pr.Out.URL.RawPath = path, escaped
			pr.Out.URL.RawQuery = r.URL.RawQuery
			pr.Out.Host = base.Host
		},
		ModifyResponse: func(res *http.Response) error {
			s.Metrics.UpstreamDuration.WithLabelValues("response").Observe(time.Since(upstreamStart).Seconds())
			if faultHeader != "" {
				res.Header.Set("X-Chaos-Fault", faultHeader)
			}
			if corrupt {
				body, err := io.ReadAll(io.LimitReader(res.Body, s.Config.MaxCorruptBytes))
				res.Body.Close()
				if err != nil {
					return err
				}
				broken := faults.CorruptBody(body)
				res.Body = io.NopCloser(bytes.NewReader(broken))
				res.ContentLength = int64(len(broken))
				res.Header.Set("Content-Length", strconv.Itoa(len(broken)))
			}
			return nil
		},
		ErrorHandler: func(rw http.ResponseWriter, _ *http.Request, err error) {
			var tooLarge *http.MaxBytesError
			switch {
			case errors.Is(err, ssrf.ErrBlocked):
				s.Metrics.UpstreamDuration.WithLabelValues("blocked").Observe(time.Since(upstreamStart).Seconds())
				jsonError(rw, http.StatusForbidden, "target_blocked", "Target address is not allowed")
			case errors.As(err, &tooLarge):
				jsonError(rw, http.StatusRequestEntityTooLarge, "payload_too_large", "Request body is too large")
			case r.Context().Err() != nil:
				// the client went away: nobody to answer
			case errors.Is(ctx.Err(), context.DeadlineExceeded):
				s.Metrics.UpstreamDuration.WithLabelValues("timeout").Observe(time.Since(upstreamStart).Seconds())
				jsonError(rw, http.StatusGatewayTimeout, "upstream_timeout", "The target did not respond in time")
			default:
				s.Metrics.UpstreamDuration.WithLabelValues("error").Observe(time.Since(upstreamStart).Seconds())
				jsonError(rw, http.StatusBadGateway, "upstream_unreachable", "Could not reach the target")
			}
		},
	}
	rp.ServeHTTP(w, r.WithContext(ctx))
}

// drop closes the connection without any response: the client sees a reset.
func drop(w *statusWriter) {
	conn, _, err := http.NewResponseController(w.ResponseWriter).Hijack()
	if err != nil {
		panic(http.ErrAbortHandler) // e.g. HTTP/2: abort the stream instead
	}
	w.hijacked = true
	if tcp, ok := conn.(*net.TCPConn); ok {
		_ = tcp.SetLinger(0) // send a reset, like the NestJS proxy's socket.destroy()
	}
	_ = conn.Close()
}

func latencyOf(rule *matching.Rule) time.Duration {
	ms := float64(intParam(rule.Params, "ms", 0))
	return time.Duration(math.Min(math.Max(ms, 0), float64(maxLatency.Milliseconds()))) * time.Millisecond
}

func intParam(params map[string]any, key string, fallback int) int {
	if v, ok := params[key].(float64); ok && v == math.Trunc(v) {
		return int(v)
	}
	return fallback
}

func fmtNum(f float64) string { return strconv.FormatFloat(f, 'f', -1, 64) }

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func jsonError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]string{"error": code, "message": message})
}
