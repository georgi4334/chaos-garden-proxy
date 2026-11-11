# Chaos Garden: Fault Proxy

The fault proxy sits between your frontend and a real (or fake) API and injects failures, so you can test how your app handles them. Rules are managed in the [control API](https://github.com/georgi4334/backend); this service reads them and applies them.

## Usage

Point your app at the proxy instead of your API:

```
ANY  http://localhost:3100/g/<gardenId>/<targetName>/<path>?<query>
```

The request is forwarded to the target's `baseUrl` + `<path>` + `<query>` (method, headers and body unchanged), unless a rule fires.

| Fault | Effect |
|---|---|
| `latency` `{ ms }` | waits `ms` (max 30000), then forwards normally |
| `error` `{ status }` | responds with that status and a JSON body, without calling the target |
| `drop` | closes the connection with no response |
| `corrupt` | forwards, then returns a malformed body (keeps the first half, appends junk) |

- A rule applies when its method (or `*`) and path pattern match. Patterns: `*` matches any run of characters, `:name` matches one path segment.
- A matching rule fires with its `probability` (0 to 1).
- At most one `latency` and one of `error`/`drop`/`corrupt` apply per request; the first that fires, in creation order, wins.
- Faulted responses carry an `x-chaos-fault` header (for example `latency,error`).

## Safety

The proxy forwards to URLs that users enter, so it blocks loopback, private, link-local and cloud-metadata addresses by default (SSRF protection). The check runs on the address actually connected to, so DNS tricks do not bypass it. Set `ALLOW_PRIVATE_TARGETS=true` for **local development only**. Request bodies are capped (`MAX_BODY_BYTES`), upstream calls time out (`UPSTREAM_TIMEOUT_MS`), and hop-by-hop headers are stripped.

## Development

```bash
npm install --legacy-peer-deps   # plain `npm install` crashes in some environments
cp .env.example .env             # INTERNAL_API_KEY must match the control API's
npm run start:dev
npm test                         # unit tests
npm run test:e2e                 # e2e tests (stub control API + local upstream, no database needed)
REDIS_URL=redis://localhost:6379 npm test           # also runs the real-Redis rate limiter tests
REDIS_URL=redis://localhost:6379 npm run test:e2e   # also runs the real-Redis event and rate limit tests
```

Run the control API (port 3000) first. Create a garden, a target and a rule through it, then call the proxy.

## Rate limiting

Each garden has its own limit (set in the dashboard, sent by the control API): a token bucket holding up to `burst` tokens that refills at `rps` per second. Each request takes a token; with none left the proxy answers **429** with `Retry-After` and `x-chaos-fault: rate_limited`, before any fault or upstream call. Every response carries `x-ratelimit-limit` and `x-ratelimit-remaining`.

The bucket lives in Redis and is updated by one Lua script, so the refill and the take are atomic and all proxy instances share one bucket per garden. If Redis is slow (over 250 ms) or down, requests are let through (fail open) and a warning is logged. Needs `REDIS_URL`; turn it off with `RATE_LIMIT_ENABLED=false`.

## Observability

- **Request IDs.** Every request gets an `x-request-id` (a valid incoming one is kept). It is returned to the caller, forwarded to the target and to the control API, and included in the request event, so the same id appears in the proxy's, the control API's and the ingest service's logs.
- **Logs.** `LOG_FORMAT=json` writes one JSON object per line with the request id; each request also gets an access-log line.
- **Metrics.** `GET /metrics` (Prometheus): `http_server_requests_seconds` by route template and status, `chaos_proxy_requests_total{outcome}`, `chaos_proxy_rate_limit_decisions_total{decision}`, `chaos_proxy_upstream_seconds{result}`, `chaos_proxy_config_lookups_total{result}`, `chaos_proxy_events_total{result}` (sent or dropped), and Node.js runtime metrics. No label contains a garden id or path. Set `METRICS_TOKEN` to require a bearer token.

Prometheus and Grafana (with a ready-made dashboard) are in `infra/` of the Chaos-Garden repo.

## Request events

After each proxied request the proxy appends one event to a Redis Stream (`chaos:requests` by default), which the ingest service reads to build request logs and stats. An event holds the garden, target, method, path (without the query string, which can carry secrets), status, duration, the faults applied and the rule ids that fired. Requests to unknown gardens or targets are not logged.

The event format is the **request-event v1 contract**, a JSON Schema owned by the Chaos-Garden repo and copied into `contracts/`. The e2e tests validate every event the proxy publishes against it, strictly (no undocumented properties). `npm run contract:check` (also in CI) fails if the copy was edited or differs from Chaos-Garden's `main`; `npm run contract:sync` updates it. To add a field, change the contract in Chaos-Garden first.

Publishing is fire-and-forget: if Redis is slow or down, events are dropped and counted, and proxying is never delayed. The stream is capped (`EVENT_STREAM_MAXLEN`) so Redis memory stays bounded if the ingest service is stopped. Leave `REDIS_URL` empty to turn events off.

## Go implementation

`go/` holds a second implementation of this proxy in Go: same URLs, faults, contract, rate limiter (it even shares the Redis buckets) and metric names, so either can run in front of the same control API, Redis and dashboards. On one CPU core it handled about 4.7× the requests of this NestJS version with about 7× lower p99 latency and an eighth of the memory; see [go/README.md](go/README.md) for the benchmark and how to read it.

## Docker and CI

- `docker build -t chaos-garden-proxy .` builds a two-stage image (`node:22-bookworm-slim`, production dependencies only, runs as `node`, with a health check). To run the whole system in containers, see `infra/compose.stack.yml` in the Chaos-Garden repo.
- `.github/workflows/ci.yml` runs lint, build, unit and e2e tests (with a Redis service container, so the rate limiter and event tests run too) on every pull request and on `main`, then builds the image. On `main` it pushes it to `ghcr.io/<owner>/chaos-garden-proxy`.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3100` | proxy port |
| `CONTROL_API_URL` | `http://localhost:3000` | control API base URL |
| `INTERNAL_API_KEY` | none | shared key sent as `x-internal-key` |
| `ALLOW_PRIVATE_TARGETS` | `false` | allow localhost/private targets (dev only) |
| `CONFIG_CACHE_TTL_MS` | `5000` | how long a garden's config is cached (0 = off) |
| `UPSTREAM_TIMEOUT_MS` | `10000` | max wait for the target |
| `MAX_BODY_BYTES` | `1048576` | max request body size |
| `REDIS_URL` | none (events off) | Redis for request events |
| `EVENT_STREAM` | `chaos:requests` | stream name |
| `EVENT_STREAM_MAXLEN` | `100000` | approximate stream length cap |
| `RATE_LIMIT_ENABLED` | `true` | per-garden rate limiting (needs `REDIS_URL`) |
| `RATE_LIMIT_DEFAULT_RPS` | `10` | used if the control API sends no limit |
| `RATE_LIMIT_DEFAULT_BURST` | `20` | used if the control API sends no limit |
