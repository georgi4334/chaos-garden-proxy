// Package controlapi fetches a garden's targets, rules and rate limit from the
// control API, with a short in-memory cache.
package controlapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/georgi4334/chaos-garden-proxy/go/internal/matching"
	"github.com/georgi4334/chaos-garden-proxy/go/internal/observability"
)

type RateLimit struct {
	RPS   float64 `json:"rps"`
	Burst float64 `json:"burst"`
}

type Target struct {
	ID      string          `json:"id"`
	Name    string          `json:"name"`
	BaseURL string          `json:"baseUrl"`
	Rules   []matching.Rule `json:"rules"`
}

type GardenConfig struct {
	GardenID  string     `json:"gardenId"`
	RateLimit *RateLimit `json:"rateLimit"`
	Targets   []Target   `json:"targets"`
}

// ErrUnavailable means the control API could not be reached or answered with an error.
var ErrUnavailable = errors.New("control API unavailable")

type entry struct {
	value   *GardenConfig // nil: garden not found
	expires time.Time
}

type Client struct {
	baseURL, key string
	ttl          time.Duration
	http         *http.Client
	metrics      *observability.Metrics
	mu           sync.Mutex
	cache        map[string]entry
}

func New(baseURL, key string, ttl time.Duration, metrics *observability.Metrics) *Client {
	return &Client{baseURL: baseURL, key: key, ttl: ttl, metrics: metrics,
		http: &http.Client{Timeout: 5 * time.Second}, cache: map[string]entry{}}
}

// Garden returns the config, nil if the garden doesn't exist, or ErrUnavailable.
func (c *Client) Garden(ctx context.Context, gardenID string) (*GardenConfig, error) {
	now := time.Now()
	c.mu.Lock()
	if e, ok := c.cache[gardenID]; ok && now.Before(e.expires) {
		c.mu.Unlock()
		c.metrics.ConfigLookups.WithLabelValues("hit").Inc()
		return e.value, nil
	}
	c.mu.Unlock()

	req, _ := http.NewRequestWithContext(ctx, http.MethodGet,
		fmt.Sprintf("%s/internal/gardens/%s/config", c.baseURL, gardenID), nil)
	req.Header.Set("x-internal-key", c.key)
	if id := observability.RequestID(ctx); id != "" {
		req.Header.Set(observability.RequestIDHeader, id)
	}
	res, err := c.http.Do(req)
	if err != nil {
		c.metrics.ConfigLookups.WithLabelValues("error").Inc()
		return nil, ErrUnavailable
	}
	defer res.Body.Close()

	var value *GardenConfig
	switch {
	case res.StatusCode == http.StatusNotFound:
		c.metrics.ConfigLookups.WithLabelValues("not_found").Inc()
	case res.StatusCode >= 200 && res.StatusCode < 300:
		value = &GardenConfig{}
		if err := json.NewDecoder(res.Body).Decode(value); err != nil {
			c.metrics.ConfigLookups.WithLabelValues("error").Inc()
			return nil, ErrUnavailable
		}
		c.metrics.ConfigLookups.WithLabelValues("fetched").Inc()
	default:
		c.metrics.ConfigLookups.WithLabelValues("error").Inc()
		return nil, ErrUnavailable
	}

	if c.ttl > 0 {
		c.mu.Lock()
		c.cache[gardenID] = entry{value: value, expires: now.Add(c.ttl)}
		if len(c.cache) > 1000 {
			for k, e := range c.cache {
				if now.After(e.expires) {
					delete(c.cache, k)
				}
			}
		}
		c.mu.Unlock()
	}
	return value, nil
}
