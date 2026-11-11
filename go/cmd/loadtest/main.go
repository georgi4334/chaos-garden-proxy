// Command loadtest benchmarks a Chaos Garden proxy.
//
//	loadtest target -addr :4000                       a minimal API to proxy to
//	loadtest run -url URL -c 50 -d 20s -warmup 3s     send load, print results as JSON
//
// It keeps connections alive and measures every request, so results show
// throughput (requests/second) and latency percentiles of the proxy, not of
// connection setup.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"slices"
	"sync"
	"time"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: loadtest target|run [flags]")
		os.Exit(2)
	}
	switch os.Args[1] {
	case "target":
		target(os.Args[2:])
	case "run":
		run(os.Args[2:])
	default:
		fmt.Fprintln(os.Stderr, "usage: loadtest target|run [flags]")
		os.Exit(2)
	}
}

func target(args []string) {
	fs := flag.NewFlagSet("target", flag.ExitOnError)
	addr := fs.String("addr", ":4000", "listen address")
	_ = fs.Parse(args)
	body := []byte(`{"id":42,"name":"chaos garden","tags":["a","b","c"],"ok":true}`)
	http.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(body)
	})
	fmt.Fprintln(os.Stderr, "target listening on", *addr)
	if err := http.ListenAndServe(*addr, nil); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

type result struct {
	URL         string             `json:"url"`
	Concurrency int                `json:"concurrency"`
	Seconds     float64            `json:"seconds"`
	Requests    int                `json:"requests"`
	RPS         float64            `json:"rps"`
	Errors      int                `json:"errors"`
	Statuses    map[string]int     `json:"statuses"`
	LatencyMs   map[string]float64 `json:"latencyMs"`
}

func run(args []string) {
	fs := flag.NewFlagSet("run", flag.ExitOnError)
	url := fs.String("url", "", "URL to request (GET)")
	conc := fs.Int("c", 50, "concurrent clients")
	dur := fs.Duration("d", 20*time.Second, "measured duration")
	warmup := fs.Duration("warmup", 3*time.Second, "unmeasured warm-up before measuring")
	_ = fs.Parse(args)
	if *url == "" {
		fmt.Fprintln(os.Stderr, "-url is required")
		os.Exit(2)
	}

	client := &http.Client{Transport: &http.Transport{MaxIdleConns: *conc * 2, MaxIdleConnsPerHost: *conc * 2}, Timeout: 30 * time.Second}
	type worker struct {
		lat      []time.Duration
		statuses map[int]int
		errors   int
	}
	workers := make([]*worker, *conc)
	measuring := make(chan struct{})
	ctx, cancel := context.WithTimeout(context.Background(), *warmup+*dur)
	defer cancel()
	time.AfterFunc(*warmup, func() { close(measuring) })

	var wg sync.WaitGroup
	for i := range workers {
		w := &worker{statuses: map[int]int{}}
		workers[i] = w
		wg.Add(1)
		go func() {
			defer wg.Done()
			for ctx.Err() == nil {
				start := time.Now()
				res, err := client.Get(*url)
				if err == nil {
					_, _ = io.Copy(io.Discard, res.Body)
					res.Body.Close()
				}
				elapsed := time.Since(start)
				select {
				case <-measuring:
					if ctx.Err() != nil {
						return // the deadline hit mid-request: don't count a cut-short sample
					}
					if err != nil {
						w.errors++
					} else {
						w.statuses[res.StatusCode]++
						w.lat = append(w.lat, elapsed)
					}
				default:
				}
			}
		}()
	}
	wg.Wait()

	var all []time.Duration
	r := result{URL: *url, Concurrency: *conc, Seconds: dur.Seconds(), Statuses: map[string]int{}, LatencyMs: map[string]float64{}}
	for _, w := range workers {
		all = append(all, w.lat...)
		r.Errors += w.errors
		for code, n := range w.statuses {
			r.Statuses[fmt.Sprint(code)] += n
		}
	}
	slices.Sort(all)
	r.Requests = len(all) + r.Errors
	r.RPS = float64(len(all)) / dur.Seconds()
	pct := func(p float64) float64 {
		if len(all) == 0 {
			return 0
		}
		return float64(all[min(len(all)-1, int(p*float64(len(all))))].Microseconds()) / 1000
	}
	for _, p := range []struct {
		name string
		q    float64
	}{{"p50", 0.50}, {"p90", 0.90}, {"p99", 0.99}, {"max", 1}} {
		r.LatencyMs[p.name] = pct(p.q)
	}
	out, _ := json.Marshal(r)
	fmt.Println(string(out))
}
