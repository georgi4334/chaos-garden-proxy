// Package events publishes one request event per proxied request to a Redis
// Stream, for the ingest service. The format is the request-event v1 contract
// (../contracts/request-event.v1.schema.json).
package events

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/georgi4334/chaos-garden-proxy/go/internal/observability"
)

// Event is request-event v1. Field names and omissions must match the schema.
type Event struct {
	V          int      `json:"v"`
	ID         string   `json:"id"`
	At         string   `json:"at"`
	GardenID   string   `json:"gardenId"`
	TargetID   string   `json:"targetId"`
	TargetName string   `json:"targetName"`
	Method     string   `json:"method"`
	Path       string   `json:"path"`
	Status     *int     `json:"status"` // null when no response was sent
	Completed  bool     `json:"completed"`
	DurationMs int64    `json:"durationMs"`
	Faults     []string `json:"faults"`
	RuleIDs    []string `json:"ruleIds"`
	RequestID  string   `json:"requestId,omitempty"`
}

// Publisher is what the proxy needs; tests use a fake.
type Publisher interface {
	Publish(Event)
}

// RedisPublisher is fire-and-forget: Publish never blocks. Events go through
// a bounded queue to a few background workers; if Redis is slow or down and
// the queue fills up, new events are dropped and counted, never piled up.
type RedisPublisher struct {
	client   *redis.Client
	stream   string
	maxLen   int64
	queue    chan Event
	metrics  *observability.Metrics
	log      *slog.Logger
	wg       sync.WaitGroup
	lastWarn time.Time
	warnMu   sync.Mutex
}

func NewRedisPublisher(client *redis.Client, stream string, maxLen int64, metrics *observability.Metrics, log *slog.Logger) *RedisPublisher {
	p := &RedisPublisher{client: client, stream: stream, maxLen: maxLen, queue: make(chan Event, 10_000), metrics: metrics, log: log}
	for range 2 {
		p.wg.Add(1)
		go p.worker()
	}
	return p
}

func (p *RedisPublisher) Publish(e Event) {
	select {
	case p.queue <- e:
	default:
		p.metrics.Events.WithLabelValues("dropped").Inc()
		p.warn("Dropped request event: queue full")
	}
}

func (p *RedisPublisher) worker() {
	defer p.wg.Done()
	for e := range p.queue {
		data, _ := json.Marshal(e)
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		err := p.client.XAdd(ctx, &redis.XAddArgs{Stream: p.stream, MaxLen: p.maxLen, Approx: true, Values: map[string]any{"data": data}}).Err()
		cancel()
		if err != nil {
			p.metrics.Events.WithLabelValues("dropped").Inc()
			p.warn("Dropped request event: " + err.Error())
			continue
		}
		p.metrics.Events.WithLabelValues("sent").Inc()
	}
}

// Close stops accepting events and waits (up to timeout) for queued ones to be sent.
func (p *RedisPublisher) Close(timeout time.Duration) {
	close(p.queue)
	done := make(chan struct{})
	go func() { p.wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(timeout):
	}
}

// warn is rate-limited so a Redis outage doesn't flood the logs.
func (p *RedisPublisher) warn(msg string) {
	p.warnMu.Lock()
	defer p.warnMu.Unlock()
	if time.Since(p.lastWarn) < 30*time.Second {
		return
	}
	p.lastWarn = time.Now()
	p.log.Warn(msg)
}
