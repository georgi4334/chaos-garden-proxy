# Chaos Garden fault proxy: Go implementation

A second implementation of the same proxy, written in Go with the standard library's `net/http` and `httputil.ReverseProxy`. It is a **drop-in replacement** for the NestJS proxy in the parent folder:

- the same URLs (`/g/<gardenId>/<targetName>/...`, `/health`, `/metrics`), environment variables, responses and headers;
- the same faults (latency, error, drop, corrupt), SSRF protection, body limit, upstream timeout and CORS;
- the same **request-event v1** contract (`../contracts/`); every event in the tests is validated against it;
- the same **rate limiter**: the same Lua token bucket on the same Redis keys, so both implementations even share a garden's bucket;
- the same Prometheus metric names, so the Grafana dashboard works with either. Go series also carry `impl="go"`, and the runtime metrics are Go's (`go_*`) instead of Node's (`nodejs_*`).

## Layout

| Path | What it does |
|---|---|
| `cmd/proxy` | the server: wiring, graceful shutdown, `proxy healthcheck` for Docker |
| `cmd/loadtest` | load generator (`run`) and a minimal target API (`target`) for benchmarks |
| `internal/proxy` | the HTTP handler: routing, faults, forwarding; integration tests |
| `internal/matching` | path patterns and rule selection |
| `internal/ssrf` | blocks private addresses at **connect time** (`net.Dialer.Control`), so DNS tricks can't bypass it |
| `internal/ratelimit` | Redis token bucket (fails open, and skips Redis for a second after an error so requests aren't slowed) |
| `internal/events` | request events to the Redis Stream through a bounded queue: publishing never blocks; overflow is dropped and counted |
| `internal/controlapi` | garden config from the control API, with a short cache |
| `internal/observability` | request ids, `slog` logs (`LOG_FORMAT=json`), Prometheus metrics |

## Run and test

```bash
cd go
go run ./cmd/proxy                         # same env vars as the NestJS proxy, port 3100
go test ./...                              # unit and integration tests
REDIS_URL=redis://localhost:6379 go test -race ./...   # also the real-Redis rate limit test, with the race detector
docker build -t chaos-garden-proxy-go .    # ~10 MB static binary on a distroless image
```

CI runs `gofmt`, `go vet` and `go test -race` (with Redis), then builds the image; on `main` it is pushed to `ghcr.io/<owner>/chaos-garden-proxy-go`.

## Differences from the NestJS proxy

- Incoming `Forwarded` / `X-Forwarded-*` headers are not passed to the target (`ReverseProxy` in Rewrite mode strips them); the NestJS proxy passes them through.
- Log lines use `slog`'s field names (`level: "INFO"`, `msg`) rather than Nest's.
- The Grafana "event loop lag" panel has no data for the Go proxy (Go has no event loop).

## Benchmark: Go vs NestJS

Pass-through requests (no faults) to a tiny JSON API, same machine, same settings for both: request events published to Redis, JSON logs (to `/dev/null`), metrics on, rate limiting off unless stated. Medians of 3 runs of 15 s each, after a 3 s warm-up, 50 concurrent keep-alive clients.

| Proxy | Requests/s | p50 | p99 | CPU per 1,000 requests | Peak memory |
|---|---:|---:|---:|---:|---:|
| NestJS, 1 core | 1,464 | 30.2 ms | 109 ms | 678 ms | 207 MB |
| **Go, 1 core** | **6,862** | **6.2 ms** | **16.2 ms** | **145 ms** | **27 MB** |
| NestJS, 1 core, rate limiter on | 1,575 | 29.1 ms | 103 ms | 624 ms | 211 MB |
| Go, 1 core, rate limiter on | 6,326 | 7.3 ms | 17.9 ms | 154 ms | 27 MB |
| Go, 2 cores | 11,187 | 3.5 ms | 13.8 ms | 161 ms | 29 MB |
| *(no proxy: load generator straight to the target)* | *33,114* | *1.4 ms* | *4.2 ms* | | |

On one core, the Go proxy handled about **4.7× the requests** at about **5× lower median and 7× lower p99 latency**, using about **4.7× less CPU per request** and **7–8× less memory**. With two cores it reached 11,200 requests/s in one process. Checking the Redis rate limiter on every request cost Go about 8%; for NestJS the difference was within run-to-run noise. No run had errors or non-200 responses.

**How to read this.** It compares the two *implementations*, framework included (NestJS on Express, with its middleware, versus `net/http`), not Node.js and Go in general. Node runs JavaScript on one thread, so the one-core rows are the like-for-like comparison; a Node deployment would use several processes (cluster mode or more containers) to use more cores, while Go uses them in one process. The numbers come from a 4-core cloud sandbox, not dedicated hardware: absolute values will differ on your machine, the ratios are the useful part.

**Setup.** `taskset` pinned the proxy to core 0 (cores 0–1 for the two-core run), the load generator to core 2 and the target to core 3; the control API was unpinned (garden config is cached, so it is rarely called). Runs alternated between implementations. CPU time and peak memory (`VmHWM`) were read from `/proc/<pid>`. To reproduce, with the control API, Redis and a garden whose target points at the load-test target:

```bash
go build -o loadtest ./cmd/loadtest
taskset -c 3 ./loadtest target -addr :4000 &
# start one proxy pinned to core 0, e.g.: RATE_LIMIT_ENABLED=false GOMAXPROCS=1 taskset -c 0 go run ./cmd/proxy
taskset -c 2 ./loadtest run -url http://localhost:3100/g/<gardenId>/<target>/items -c 50 -d 15s -warmup 3s
```
