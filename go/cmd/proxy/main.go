// Command proxy runs the Chaos Garden fault proxy (Go implementation).
// Configuration is the same environment variables as the NestJS proxy.
package main

import (
	"context"
	"errors"
	"math/rand/v2"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/georgi4334/chaos-garden-proxy/go/internal/config"
	"github.com/georgi4334/chaos-garden-proxy/go/internal/controlapi"
	"github.com/georgi4334/chaos-garden-proxy/go/internal/events"
	"github.com/georgi4334/chaos-garden-proxy/go/internal/observability"
	"github.com/georgi4334/chaos-garden-proxy/go/internal/proxy"
	"github.com/georgi4334/chaos-garden-proxy/go/internal/ratelimit"
)

type noEvents struct{}

func (noEvents) Publish(events.Event) {}

func main() {
	cfg := config.Load()
	// `proxy healthcheck` is for Docker's HEALTHCHECK: the image has no shell or curl.
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		client := &http.Client{Timeout: 2 * time.Second}
		res, err := client.Get("http://127.0.0.1:" + cfg.Port + "/health")
		if err != nil || res.StatusCode != http.StatusOK {
			os.Exit(1)
		}
		os.Exit(0)
	}
	logger := observability.NewLogger(cfg.LogFormat)
	metrics := observability.NewMetrics()

	var rdb *redis.Client
	var publisher events.Publisher = noEvents{}
	var limiterClient *redis.Client
	if cfg.RedisURL != "" {
		opts, err := redis.ParseURL(cfg.RedisURL)
		if err != nil {
			logger.Error("invalid REDIS_URL", "error", err)
			os.Exit(1)
		}
		// A slow Redis must not slow requests down: give up quickly (and fail open).
		opts.DialTimeout, opts.ReadTimeout, opts.WriteTimeout, opts.MaxRetries = 250*time.Millisecond, 250*time.Millisecond, 250*time.Millisecond, -1
		rdb = redis.NewClient(opts)
		publisher = events.NewRedisPublisher(rdb, cfg.EventStream, cfg.EventStreamMaxLen, metrics, logger)
		if cfg.RateLimitEnabled {
			limiterClient = rdb
		}
	}

	server := proxy.New(proxy.Options{
		Config:  cfg,
		Gardens: controlapi.New(cfg.ControlAPIURL, cfg.InternalAPIKey, cfg.ConfigCacheTTL, metrics),
		Events:  publisher,
		Limiter: ratelimit.New(limiterClient, logger),
		Metrics: metrics,
		Log:     logger,
		Random:  rand.Float64,
	})
	httpServer := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           server.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		logger.Info("Chaos Garden proxy (Go) listening", "port", cfg.Port)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("server failed", "error", err)
			os.Exit(1)
		}
	}()
	<-ctx.Done()

	// Graceful shutdown: stop accepting, finish in-flight requests, flush events.
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = httpServer.Shutdown(shutdownCtx)
	if p, ok := publisher.(*events.RedisPublisher); ok {
		p.Close(3 * time.Second)
	}
	if rdb != nil {
		_ = rdb.Close()
	}
	logger.Info("stopped")
}
