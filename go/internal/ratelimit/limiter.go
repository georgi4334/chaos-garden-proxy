// Package ratelimit enforces each garden's rate limit with a token bucket in
// Redis. It runs the same Lua script, on the same keys, as the NestJS proxy,
// so both implementations can even share buckets.
package ratelimit

import (
	"context"
	"log/slog"
	"math"
	"strconv"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// Refill and take one token atomically. KEYS[1] = bucket; ARGV = rate, burst, now (ms), cost.
// Returns { allowed (1/0), tokens left (string), retry after (ms) }.
var tokenBucket = redis.NewScript(`
local rate = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])

local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts = tonumber(state[2])
if tokens == nil then
  tokens = burst
  ts = now
end
if now > ts then
  tokens = math.min(burst, tokens + (now - ts) * rate / 1000)
  ts = now
end

local allowed = 0
local retry_ms = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  retry_ms = math.ceil((cost - tokens) * 1000 / rate)
end

redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', ts)
-- Forget the bucket once it would be full again anyway.
redis.call('PEXPIRE', KEYS[1], math.ceil(burst * 1000 / rate) + 1000)
return { allowed, tostring(tokens), retry_ms }
`)

type Decision struct {
	Allowed    bool
	Remaining  int
	RetryAfter time.Duration
}

type Limiter struct {
	client *redis.Client // nil: limiting off
	log    *slog.Logger

	mu        sync.Mutex
	pauseTill time.Time // after a Redis error, skip Redis briefly so requests aren't slowed
	lastWarn  time.Time
}

func New(client *redis.Client, log *slog.Logger) *Limiter { return &Limiter{client: client, log: log} }

// Take takes one token for the garden. It returns nil when limiting is off or
// Redis is unavailable: the proxy then lets the request through (fail open).
func (l *Limiter) Take(ctx context.Context, gardenID string, rps, burst float64, now time.Time) *Decision {
	if l == nil || l.client == nil {
		return nil
	}
	l.mu.Lock()
	paused := now.Before(l.pauseTill)
	l.mu.Unlock()
	if paused {
		return nil
	}
	res, err := tokenBucket.Run(ctx, l.client, []string{"chaos:ratelimit:garden:" + gardenID},
		rps, burst, now.UnixMilli(), 1).Slice()
	if err != nil || len(res) != 3 {
		l.mu.Lock()
		l.pauseTill = now.Add(time.Second)
		if now.Sub(l.lastWarn) >= 30*time.Second {
			l.lastWarn = now
			l.log.Warn("Rate limiting skipped, Redis unavailable", "error", err)
		}
		l.mu.Unlock()
		return nil
	}
	allowed, _ := res[0].(int64)
	tokens, _ := strconv.ParseFloat(res[1].(string), 64)
	retry, _ := res[2].(int64)
	return &Decision{Allowed: allowed == 1, Remaining: int(math.Floor(tokens)), RetryAfter: time.Duration(retry) * time.Millisecond}
}
