// Package ratelimit is an in-memory token bucket per key.
package ratelimit

import (
	"sync"
	"time"
)

type bucket struct {
	tokens  float64
	updated time.Time
}

// Limiter allows `limit` events per `per` for each key, with bursts up to `limit`.
type Limiter struct {
	mu      sync.Mutex
	limit   float64
	rate    float64 // tokens per second
	buckets map[string]*bucket
}

func New(limit int, per time.Duration) *Limiter {
	return &Limiter{limit: float64(limit), rate: float64(limit) / per.Seconds(), buckets: map[string]*bucket{}}
}

// Allow takes one token for key. It returns false, and how long to wait,
// when the key is out of tokens.
func (l *Limiter) Allow(key string) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	b, ok := l.buckets[key]
	if !ok {
		b = &bucket{tokens: l.limit, updated: now}
		l.buckets[key] = b
		if len(l.buckets) > 100_000 {
			l.prune(now)
		}
	}
	b.tokens = min(l.limit, b.tokens+now.Sub(b.updated).Seconds()*l.rate)
	b.updated = now
	if b.tokens < 1 {
		return false, time.Duration((1 - b.tokens) / l.rate * float64(time.Second))
	}
	b.tokens--
	return true, 0
}

func (l *Limiter) prune(now time.Time) {
	for k, b := range l.buckets {
		if b.tokens+now.Sub(b.updated).Seconds()*l.rate >= l.limit {
			delete(l.buckets, k)
		}
	}
}
