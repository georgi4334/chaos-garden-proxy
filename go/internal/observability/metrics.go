package observability

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
)

// Metrics uses the same names and labels as the NestJS proxy, so the Grafana
// dashboard works with either implementation. Every series also carries
// impl="go" to tell them apart.
type Metrics struct {
	Registry          *prometheus.Registry
	HTTPDuration      *prometheus.HistogramVec
	Requests          *prometheus.CounterVec
	UpstreamDuration  *prometheus.HistogramVec
	RateLimitDecision *prometheus.CounterVec
	ConfigLookups     *prometheus.CounterVec
	Events            *prometheus.CounterVec
}

func NewMetrics() *Metrics {
	reg := prometheus.NewRegistry()
	r := prometheus.WrapRegistererWith(prometheus.Labels{"service": "proxy", "impl": "go"}, reg)
	r.MustRegister(collectors.NewGoCollector(), collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))
	m := &Metrics{
		Registry: reg,
		HTTPDuration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "http_server_requests_seconds",
			Help:    "HTTP requests handled by this service, by route template and status",
			Buckets: []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30},
		}, []string{"method", "route", "status_code"}),
		Requests: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "chaos_proxy_requests_total",
			Help: "Proxied requests by outcome (ok, slow, error, drop, corrupt, target_error, no_response, rate_limited)",
		}, []string{"outcome"}),
		UpstreamDuration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "chaos_proxy_upstream_seconds",
			Help:    "Time from sending a request to the target until its response headers (or failure)",
			Buckets: []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10},
		}, []string{"result"}),
		RateLimitDecision: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "chaos_proxy_rate_limit_decisions_total",
			Help: "Rate limit checks: allowed, limited, or skipped (Redis unavailable or limiting off)",
		}, []string{"decision"}),
		ConfigLookups: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "chaos_proxy_config_lookups_total",
			Help: "Garden config lookups: cache hit, fetched from the control API, not found, or error",
		}, []string{"result"}),
		Events: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "chaos_proxy_events_total",
			Help: "Request events for the ingest service: sent to Redis, or dropped",
		}, []string{"result"}),
	}
	r.MustRegister(m.HTTPDuration, m.Requests, m.UpstreamDuration, m.RateLimitDecision, m.ConfigLookups, m.Events)
	return m
}

// OutcomeOf classifies a request exactly like the ingest service does.
func OutcomeOf(faults []string, status int) string {
	has := func(f string) bool {
		for _, x := range faults {
			if x == f {
				return true
			}
		}
		return false
	}
	switch {
	case has("rate_limited"):
		return "rate_limited"
	case has("drop"):
		return "drop"
	case has("error"):
		return "error"
	case status == 0:
		return "no_response"
	case has("corrupt"):
		return "corrupt"
	case status >= 400:
		return "target_error"
	case has("latency"):
		return "slow"
	default:
		return "ok"
	}
}
