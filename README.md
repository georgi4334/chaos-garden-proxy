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
```

Run the control API (port 3000) first. Create a garden, a target and a rule through it, then call the proxy.

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
