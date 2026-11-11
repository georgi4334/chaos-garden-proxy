package proxy

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math/rand/v2"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/santhosh-tekuri/jsonschema/v6"

	"github.com/georgi4334/chaos-garden-proxy/go/internal/config"
	"github.com/georgi4334/chaos-garden-proxy/go/internal/controlapi"
	"github.com/georgi4334/chaos-garden-proxy/go/internal/events"
	"github.com/georgi4334/chaos-garden-proxy/go/internal/matching"
	"github.com/georgi4334/chaos-garden-proxy/go/internal/observability"
	"github.com/georgi4334/chaos-garden-proxy/go/internal/ratelimit"
)

const (
	key           = "test-internal-key"
	garden        = "11111111-1111-4111-8111-111111111111"
	privateGarden = "22222222-2222-4222-8222-222222222222"
	targetID      = "44444444-4444-4444-8444-444444444444"
	uuidPattern   = `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`
)

type fakeEvents struct {
	mu  sync.Mutex
	all []events.Event
}

func (f *fakeEvents) Publish(e events.Event) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.all = append(f.all, e)
}

func (f *fakeEvents) snapshot() []events.Event {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]events.Event(nil), f.all...)
}

type harness struct {
	t             *testing.T
	proxy         *httptest.Server
	events        *fakeEvents
	mu            sync.Mutex
	rules         []matching.Rule
	rateLimit     *controlapi.RateLimit
	upstreamHits  atomic.Int64
	controlReqIDs []string
}

func (h *harness) setRules(rules ...matching.Rule) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.rules = rules
}

func rule(id, typ string, params map[string]any) matching.Rule {
	if params == nil {
		params = map[string]any{}
	}
	return matching.Rule{ID: id, Method: "*", PathPattern: "/*", Type: typ, Probability: 1, Params: params}
}

// newHarness starts a target that echoes requests, a stub control API, and the proxy.
func newHarness(t *testing.T, edit func(*config.Config), limiter *ratelimit.Limiter) *harness {
	t.Helper()
	h := &harness{t: t, events: &fakeEvents{}}

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.upstreamHits.Add(1)
		if r.URL.Path == "/v1/slow" {
			time.Sleep(time.Second)
		}
		body, _ := io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Upstream", "yes")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"method": r.Method, "url": r.RequestURI, "host": r.Host, "body": string(body),
			"requestId": r.Header.Get("X-Request-Id"), "big": strings.Repeat("x", 200),
		})
	}))
	t.Cleanup(upstream.Close)

	control := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.mu.Lock()
		h.controlReqIDs = append(h.controlReqIDs, r.Header.Get("X-Request-Id"))
		rules, rl := h.rules, h.rateLimit
		h.mu.Unlock()
		if r.Header.Get("x-internal-key") != key {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		var cfg *controlapi.GardenConfig
		switch {
		case strings.Contains(r.URL.Path, "/"+garden+"/"):
			cfg = &controlapi.GardenConfig{GardenID: garden, RateLimit: rl, Targets: []controlapi.Target{
				{ID: targetID, Name: "api", BaseURL: upstream.URL + "/v1", Rules: rules}}}
		case strings.Contains(r.URL.Path, "/"+privateGarden+"/"):
			cfg = &controlapi.GardenConfig{GardenID: privateGarden, Targets: []controlapi.Target{
				{ID: "55555555-5555-4555-8555-555555555555", Name: "internal", BaseURL: upstream.URL}}}
		default:
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_ = json.NewEncoder(w).Encode(cfg)
	}))
	t.Cleanup(control.Close)

	cfg := config.Config{
		ControlAPIURL: control.URL, InternalAPIKey: key, AllowPrivateTargets: true,
		UpstreamTimeout: 2 * time.Second, MaxBodyBytes: 1 << 20, MaxCorruptBytes: 5 << 20,
		DefaultRateLimitRPS: 10, DefaultRateLimitBurst: 20,
	}
	if edit != nil {
		edit(&cfg)
	}
	metrics := observability.NewMetrics()
	srv := New(Options{
		Config: cfg, Gardens: controlapi.New(cfg.ControlAPIURL, cfg.InternalAPIKey, cfg.ConfigCacheTTL, metrics),
		Events: h.events, Limiter: limiter, Metrics: metrics, Log: observability.NewLoggerTo(io.Discard, ""),
		Random: rand.Float64,
	})
	h.proxy = httptest.NewServer(srv.Handler())
	t.Cleanup(h.proxy.Close)
	t.Cleanup(func() { assertContract(t, h.events.snapshot()) })
	return h
}

func (h *harness) do(method, path string, body io.Reader, headers map[string]string) (*http.Response, []byte) {
	h.t.Helper()
	req, _ := http.NewRequest(method, h.proxy.URL+path, body)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatalf("%s %s: %v", method, path, err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res, b
}

func (h *harness) get(path string) (*http.Response, []byte) { return h.do("GET", path, nil, nil) }

func expectStatus(t *testing.T, res *http.Response, want int) {
	t.Helper()
	if res.StatusCode != want {
		t.Fatalf("status = %d, want %d", res.StatusCode, want)
	}
}

func decode(t *testing.T, b []byte) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("not JSON: %s", b)
	}
	return m
}

func TestPassthrough(t *testing.T) {
	h := newHarness(t, nil, nil)
	res, b := h.do("POST", "/g/"+garden+"/api/users/7?x=1&y=two", strings.NewReader(`{"hello":"world"}`),
		map[string]string{"Content-Type": "application/json"})
	expectStatus(t, res, 200)
	body := decode(t, b)
	if body["url"] != "/v1/users/7?x=1&y=two" || body["method"] != "POST" || body["body"] != `{"hello":"world"}` {
		t.Errorf("forwarded request differs: %v", body)
	}
	if !strings.HasPrefix(h.proxy.URL, "http://") || body["host"] == "" || strings.Contains(body["host"].(string), h.proxy.Listener.Addr().String()) {
		t.Errorf("Host must be rewritten to the target, got %v", body["host"])
	}
	if res.Header.Get("X-Chaos-Fault") != "" || res.Header.Get("X-Upstream") != "yes" {
		t.Error("passthrough should carry upstream headers and no fault header")
	}
	if _, b := h.get("/g/" + garden + "/api"); decode(t, b)["url"] != "/v1/" {
		t.Error("bare target URL should forward to the base path")
	}
}

func TestNotFound(t *testing.T) {
	h := newHarness(t, nil, nil)
	for _, p := range []string{"/g/33333333-3333-4333-8333-333333333333/api/x", "/g/" + garden + "/nope/x", "/g/not-a-uuid/api/x"} {
		res, _ := h.get(p)
		expectStatus(t, res, 404)
	}
	if n := len(h.events.snapshot()); n != 0 {
		t.Errorf("unknown gardens and targets must not be logged, got %d events", n)
	}
}

func TestFaults(t *testing.T) {
	h := newHarness(t, nil, nil)

	h.setRules(rule("e", "error", map[string]any{"status": 503.0}))
	hits := h.upstreamHits.Load()
	res, b := h.get("/g/" + garden + "/api/anything")
	expectStatus(t, res, 503)
	if res.Header.Get("X-Chaos-Fault") != "error" || decode(t, b)["error"] != "chaos_garden_injected_error" || h.upstreamHits.Load() != hits {
		t.Error("injected error should answer without calling the target")
	}

	h.setRules(rule("l", "latency", map[string]any{"ms": 300.0}))
	start := time.Now()
	res, _ = h.get("/g/" + garden + "/api/slow-ish")
	if expectStatus(t, res, 200); time.Since(start) < 290*time.Millisecond || res.Header.Get("X-Chaos-Fault") != "latency" {
		t.Error("latency should delay, then forward with the fault header")
	}

	h.setRules(rule("l", "latency", map[string]any{"ms": 150.0}), rule("e", "error", map[string]any{"status": 500.0}))
	start = time.Now()
	res, _ = h.get("/g/" + garden + "/api/x")
	if expectStatus(t, res, 500); time.Since(start) < 140*time.Millisecond || res.Header.Get("X-Chaos-Fault") != "latency,error" {
		t.Error("latency and error should combine")
	}

	h.setRules(rule("c", "corrupt", nil))
	res, b = h.get("/g/" + garden + "/api/data")
	expectStatus(t, res, 200)
	// encoding/json writes keys alphabetically, so the kept first half starts with "big".
	if json.Valid(b) || !bytes.HasPrefix(b, []byte(`{"big":"xxx`)) || !bytes.Contains(b, []byte("<chaos-garden>")) || res.Header.Get("X-Chaos-Fault") != "corrupt" {
		t.Errorf("corrupt should keep the start and break the JSON: %q", b)
	}

	h.setRules(rule("d", "drop", nil))
	client := &http.Client{Transport: &http.Transport{DisableKeepAlives: true}}
	if _, err := client.Get(h.proxy.URL + "/g/" + garden + "/api/x"); err == nil {
		t.Error("drop should close the connection with no response")
	}

	e := rule("e", "error", map[string]any{"status": 500.0})
	e.Method, e.PathPattern = "POST", "/orders/*"
	h.setRules(e)
	if res, _ := h.get("/g/" + garden + "/api/orders/1"); res.StatusCode != 200 {
		t.Error("GET should not match a POST rule")
	}
	if res, _ := h.do("POST", "/g/"+garden+"/api/users", nil, nil); res.StatusCode != 200 {
		t.Error("/users should not match /orders/*")
	}
	if res, _ := h.do("POST", "/g/"+garden+"/api/orders/1", nil, nil); res.StatusCode != 500 {
		t.Error("POST /orders/1 should match")
	}
}

func TestProbabilityHalf(t *testing.T) {
	h := newHarness(t, nil, nil)
	half := rule("e", "error", map[string]any{"status": 503.0})
	half.Probability = 0.5
	h.setRules(half)
	var faulted atomic.Int64
	var wg sync.WaitGroup
	for range 200 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			res, err := http.Get(h.proxy.URL + "/g/" + garden + "/api/x")
			if err == nil {
				if res.StatusCode == 503 {
					faulted.Add(1)
				}
				res.Body.Close()
			}
		}()
	}
	wg.Wait()
	if n := faulted.Load(); n <= 60 || n >= 140 {
		t.Errorf("about half should fault, got %d of 200", n)
	}
}

func TestLimitsAndFailures(t *testing.T) {
	h := newHarness(t, func(c *config.Config) { c.UpstreamTimeout = 200 * time.Millisecond }, nil)
	res, _ := h.do("POST", "/g/"+garden+"/api/upload", strings.NewReader(strings.Repeat("x", 2_000_000)), nil)
	expectStatus(t, res, 413)
	res, b := h.get("/g/" + garden + "/api/slow")
	if expectStatus(t, res, 504); decode(t, b)["error"] != "upstream_timeout" {
		t.Error("a slow target should give 504")
	}

	bad := newHarness(t, func(c *config.Config) { c.InternalAPIKey = "wrong" }, nil)
	res, _ = bad.get("/g/" + garden + "/api/x")
	expectStatus(t, res, 502)

	blocked := newHarness(t, func(c *config.Config) { c.AllowPrivateTargets = false }, nil)
	res, b = blocked.get("/g/" + privateGarden + "/internal/secret")
	if expectStatus(t, res, 403); decode(t, b)["error"] != "target_blocked" {
		t.Error("loopback target should be blocked when private targets are not allowed")
	}
}

func TestRequestIDs(t *testing.T) {
	h := newHarness(t, nil, nil)
	res, _ := h.get("/g/" + garden + "/api/a")
	if !regexp.MustCompile(uuidPattern).MatchString(res.Header.Get("X-Request-Id")) {
		t.Errorf("generated id should be a UUID, got %q", res.Header.Get("X-Request-Id"))
	}
	res, b := h.do("GET", "/g/"+garden+"/api/b", nil, map[string]string{"X-Request-Id": "trace-from-the-browser-1"})
	if res.Header.Get("X-Request-Id") != "trace-from-the-browser-1" || decode(t, b)["requestId"] != "trace-from-the-browser-1" {
		t.Error("a valid incoming id is kept and forwarded to the target")
	}
	h.mu.Lock()
	lastControl := h.controlReqIDs[len(h.controlReqIDs)-1]
	h.mu.Unlock()
	if lastControl != "trace-from-the-browser-1" {
		t.Errorf("the control API should receive the id, got %q", lastControl)
	}
	evs := h.events.snapshot()
	if evs[len(evs)-1].RequestID != "trace-from-the-browser-1" {
		t.Error("the event should carry the id")
	}
	res, _ = h.do("GET", "/g/"+garden+"/api/c", nil, map[string]string{"X-Request-Id": "bad id with spaces"})
	if res.Header.Get("X-Request-Id") == "bad id with spaces" {
		t.Error("an unsafe id must be replaced")
	}
}

func TestEvents(t *testing.T) {
	h := newHarness(t, nil, nil)
	h.get("/g/" + garden + "/api/users/7?secret=abc")
	h.setRules(rule("e1", "error", map[string]any{"status": 503.0}))
	h.do("POST", "/g/"+garden+"/api/orders", nil, nil)
	h.setRules(rule("l1", "latency", map[string]any{"ms": 50.0}), rule("d1", "drop", nil))
	client := &http.Client{Transport: &http.Transport{DisableKeepAlives: true}}
	_, _ = client.Get(h.proxy.URL + "/g/" + garden + "/api/x")
	time.Sleep(50 * time.Millisecond)

	evs := h.events.snapshot()
	if len(evs) != 3 {
		t.Fatalf("want 3 events, got %d", len(evs))
	}
	pass, errEv, drop := evs[0], evs[1], evs[2]
	if pass.Path != "/users/7" || pass.Status == nil || *pass.Status != 200 || !pass.Completed || pass.TargetID != targetID || len(pass.Faults) != 0 {
		t.Errorf("passthrough event wrong: %+v", pass)
	}
	if errEv.Method != "POST" || *errEv.Status != 503 || strings.Join(errEv.Faults, ",") != "error" || strings.Join(errEv.RuleIDs, ",") != "e1" {
		t.Errorf("error event wrong: %+v", errEv)
	}
	if drop.Status != nil || drop.Completed || strings.Join(drop.Faults, ",") != "latency,drop" || strings.Join(drop.RuleIDs, ",") != "l1,d1" || drop.DurationMs < 45 {
		t.Errorf("drop event wrong: %+v", drop)
	}
	if pass.ID == errEv.ID || errEv.ID == drop.ID {
		t.Error("event ids must be unique")
	}
}

func TestCORSAndMetrics(t *testing.T) {
	h := newHarness(t, nil, nil)
	res, _ := h.do("OPTIONS", "/g/"+garden+"/api/users", nil, map[string]string{
		"Origin": "http://my-app.test", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type"})
	if res.StatusCode != 204 || res.Header.Get("Access-Control-Allow-Origin") != "*" {
		t.Errorf("preflight: %d %v", res.StatusCode, res.Header)
	}
	h.setRules(rule("e", "error", map[string]any{"status": 503.0}))
	res, _ = h.do("GET", "/g/"+garden+"/api/metrics-check/1", nil, map[string]string{"Origin": "http://my-app.test"})
	if !strings.Contains(res.Header.Get("Access-Control-Expose-Headers"), "x-chaos-fault") {
		t.Error("the fault header must be exposed to browsers")
	}
	h.setRules()
	h.get("/g/" + garden + "/api/metrics-check/2")

	_, b := h.get("/metrics")
	text := string(b)
	for _, want := range []string{
		`chaos_proxy_requests_total{impl="go",outcome="error",service="proxy"} 1`,
		`chaos_proxy_requests_total{impl="go",outcome="ok",service="proxy"} 1`,
		`http_server_requests_seconds_count{impl="go",method="GET",route="/g/:gardenId/:targetName/*path",service="proxy",status_code="503"} 1`,
		`chaos_proxy_config_lookups_total{impl="go",result="fetched",service="proxy"}`,
		`chaos_proxy_upstream_seconds_count{impl="go",result="response",service="proxy"} 1`,
		`chaos_proxy_rate_limit_decisions_total{decision="skipped",impl="go",service="proxy"}`,
		`process_resident_memory_bytes`,
	} {
		if !strings.Contains(text, want) {
			t.Errorf("metrics missing %s", want)
		}
	}
	if strings.Contains(text, "metrics-check") {
		t.Error("raw paths must never appear in metric labels")
	}
}

func redisClient(t *testing.T) *redis.Client {
	url := os.Getenv("REDIS_URL")
	if url == "" {
		t.Skip("REDIS_URL not set")
	}
	opts, err := redis.ParseURL(url)
	if err != nil {
		t.Fatal(err)
	}
	c := redis.NewClient(opts)
	t.Cleanup(func() { _ = c.Close() })
	return c
}

func TestRateLimitWithRedis(t *testing.T) {
	limiter := ratelimit.New(redisClient(t), observability.NewLoggerTo(io.Discard, ""))
	h := newHarness(t, nil, limiter)
	h.rateLimit = &controlapi.RateLimit{RPS: 1, Burst: 3}
	// fresh bucket for this run
	_ = redisClient(t).Del(t.Context(), "chaos:ratelimit:garden:"+garden).Err()

	var statuses []int
	var refused *http.Response
	var refusedBody []byte
	for range 5 {
		res, b := h.get("/g/" + garden + "/api/x")
		statuses = append(statuses, res.StatusCode)
		if res.StatusCode == 429 {
			refused, refusedBody = res, b
		}
	}
	if got := statuses; got[0] != 200 || got[1] != 200 || got[2] != 200 || got[3] != 429 || got[4] != 429 {
		t.Fatalf("want 200,200,200,429,429 got %v", got)
	}
	if refused.Header.Get("Retry-After") != "1" || refused.Header.Get("X-Chaos-Fault") != "rate_limited" ||
		refused.Header.Get("X-Ratelimit-Limit") != "1" || refused.Header.Get("X-Ratelimit-Remaining") != "0" ||
		decode(t, refusedBody)["retryAfter"] != 1.0 {
		t.Errorf("429 headers/body wrong: %v %s", refused.Header, refusedBody)
	}
	limited := 0
	for _, e := range h.events.snapshot() {
		if strings.Join(e.Faults, ",") == "rate_limited" && e.Status != nil && *e.Status == 429 {
			limited++
		}
	}
	if limited != 2 {
		t.Errorf("want 2 rate_limited events, got %d", limited)
	}
	time.Sleep(1100 * time.Millisecond)
	if res, _ := h.get("/g/" + garden + "/api/x"); res.StatusCode != 200 {
		t.Error("a token should have refilled after a second")
	}
}

func TestRateLimitFailsOpenWhenRedisIsDown(t *testing.T) {
	dead := redis.NewClient(&redis.Options{Addr: "127.0.0.1:1", DialTimeout: 100 * time.Millisecond, MaxRetries: -1})
	t.Cleanup(func() { _ = dead.Close() })
	h := newHarness(t, nil, ratelimit.New(dead, observability.NewLoggerTo(io.Discard, "")))
	start := time.Now()
	for range 5 {
		res, _ := h.get("/g/" + garden + "/api/x")
		expectStatus(t, res, 200)
	}
	if time.Since(start) > 1500*time.Millisecond {
		t.Errorf("a down Redis must not slow requests much: took %v", time.Since(start))
	}
	_, b := h.get("/metrics")
	if !strings.Contains(string(b), `chaos_proxy_rate_limit_decisions_total{decision="skipped"`) {
		t.Error("decisions should be counted as skipped")
	}
}

// ---- contract: every event the proxy publishes must match request-event v1, strictly ----

var (
	schemaOnce sync.Once
	schema     *jsonschema.Schema
	schemaKeys map[string]bool
	schemaErr  error
)

func contractPath(parts ...string) string {
	return filepath.Join(append([]string{"..", "..", "..", "contracts"}, parts...)...)
}

func loadSchema(t *testing.T) *jsonschema.Schema {
	t.Helper()
	schemaOnce.Do(func() {
		path, _ := filepath.Abs(contractPath("request-event.v1.schema.json"))
		c := jsonschema.NewCompiler()
		c.AssertFormat()
		schema, schemaErr = c.Compile(path)
		raw, _ := os.ReadFile(path)
		var doc struct {
			Properties map[string]any `json:"properties"`
		}
		_ = json.Unmarshal(raw, &doc)
		schemaKeys = map[string]bool{}
		for k := range doc.Properties {
			schemaKeys[k] = true
		}
	})
	if schemaErr != nil {
		t.Fatalf("loading the contract: %v", schemaErr)
	}
	return schema
}

func validate(t *testing.T, raw []byte) error {
	inst, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
	if err != nil {
		return err
	}
	return loadSchema(t).Validate(inst)
}

func assertContract(t *testing.T, evs []events.Event) {
	t.Helper()
	for _, e := range evs {
		raw, _ := json.Marshal(e)
		if err := validate(t, raw); err != nil {
			t.Errorf("event does not match the contract: %v\n%s", err, raw)
		}
		var m map[string]any
		_ = json.Unmarshal(raw, &m)
		for k := range m {
			if !schemaKeys[k] {
				t.Errorf("undocumented property %q in event", k)
			}
		}
	}
}

func TestContractFixtures(t *testing.T) {
	for _, kind := range []string{"valid", "invalid"} {
		files, _ := filepath.Glob(contractPath("fixtures", kind, "*.json"))
		if len(files) == 0 {
			t.Fatalf("no %s fixtures found", kind)
		}
		for _, f := range files {
			raw, _ := os.ReadFile(f)
			err := validate(t, raw)
			if (kind == "valid") != (err == nil) {
				t.Errorf("%s/%s: validator disagrees with the fixture (%v)", kind, filepath.Base(f), err)
			}
		}
	}
	var none *jsonschema.ValidationError
	_ = errors.As(nil, &none)
}
