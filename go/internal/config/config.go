// Package config reads the proxy's settings from the environment, with the
// same variable names and defaults as the NestJS proxy.
package config

import (
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Port                  string
	ControlAPIURL         string
	InternalAPIKey        string
	AllowPrivateTargets   bool
	ConfigCacheTTL        time.Duration
	UpstreamTimeout       time.Duration
	MaxBodyBytes          int64
	MaxCorruptBytes       int64
	RedisURL              string
	EventStream           string
	EventStreamMaxLen     int64
	RateLimitEnabled      bool
	DefaultRateLimitRPS   float64
	DefaultRateLimitBurst float64
	LogFormat             string
	MetricsToken          string
}

func Load() Config {
	return Config{
		Port:                  str("PORT", "3100"),
		ControlAPIURL:         strings.TrimRight(str("CONTROL_API_URL", "http://localhost:3000"), "/"),
		InternalAPIKey:        os.Getenv("INTERNAL_API_KEY"),
		AllowPrivateTargets:   os.Getenv("ALLOW_PRIVATE_TARGETS") == "true",
		ConfigCacheTTL:        time.Duration(num("CONFIG_CACHE_TTL_MS", 5000)) * time.Millisecond,
		UpstreamTimeout:       time.Duration(num("UPSTREAM_TIMEOUT_MS", 10000)) * time.Millisecond,
		MaxBodyBytes:          int64(num("MAX_BODY_BYTES", 1_048_576)),
		MaxCorruptBytes:       int64(num("MAX_CORRUPT_BYTES", 5_242_880)),
		RedisURL:              os.Getenv("REDIS_URL"),
		EventStream:           str("EVENT_STREAM", "chaos:requests"),
		EventStreamMaxLen:     int64(num("EVENT_STREAM_MAXLEN", 100_000)),
		RateLimitEnabled:      os.Getenv("RATE_LIMIT_ENABLED") != "false",
		DefaultRateLimitRPS:   num("RATE_LIMIT_DEFAULT_RPS", 10),
		DefaultRateLimitBurst: num("RATE_LIMIT_DEFAULT_BURST", 20),
		LogFormat:             os.Getenv("LOG_FORMAT"),
		MetricsToken:          os.Getenv("METRICS_TOKEN"),
	}
}

func str(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func num(key string, fallback float64) float64 {
	v, err := strconv.ParseFloat(os.Getenv(key), 64)
	if err != nil || v < 0 {
		return fallback
	}
	return v
}
