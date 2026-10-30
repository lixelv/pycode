// Package identity gives every browser a permanent UUIDv7 kept in a cookie.
package identity

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

const cookieName = "pc_uid"

type ctxKey struct{}

// Public is what others may see of a user: the cookie id itself is the
// credential (whoever sends it is that user), so it never leaves the server.
func Public(id uuid.UUID) string {
	sum := sha256.Sum256([]byte("pycode-public:" + id.String()))
	return hex.EncodeToString(sum[:16])
}

// FromContext returns the caller's id; Middleware always sets it.
func FromContext(ctx context.Context) uuid.UUID {
	id, _ := ctx.Value(ctxKey{}).(uuid.UUID)
	return id
}

// Middleware reads the id cookie or issues a new UUIDv7, records the user and
// puts the id into the request context.
type Middleware struct {
	pool *pgxpool.Pool
	mu   sync.Mutex
	seen map[uuid.UUID]time.Time // last time last_seen was written
}

func NewMiddleware(pool *pgxpool.Pool) *Middleware {
	return &Middleware{pool: pool, seen: map[uuid.UUID]time.Time{}}
}

func (m *Middleware) Wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id, fresh := m.identify(r)
		if fresh {
			http.SetCookie(w, &http.Cookie{
				Name:     cookieName,
				Value:    id.String(),
				Path:     "/",
				MaxAge:   10 * 365 * 24 * 60 * 60,
				HttpOnly: true,
				Secure:   r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https",
				SameSite: http.SameSiteLaxMode,
			})
		}
		m.touch(r.Context(), id)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, id)))
	})
}

func (m *Middleware) identify(r *http.Request) (uuid.UUID, bool) {
	if c, err := r.Cookie(cookieName); err == nil {
		if id, err := uuid.Parse(c.Value); err == nil && id.Version() == 7 {
			return id, false
		}
	}
	return uuid.Must(uuid.NewV7()), true
}

// touch upserts the user, at most once a minute per id.
func (m *Middleware) touch(ctx context.Context, id uuid.UUID) {
	m.mu.Lock()
	last, ok := m.seen[id]
	now := time.Now()
	if ok && now.Sub(last) < time.Minute {
		m.mu.Unlock()
		return
	}
	m.seen[id] = now
	if len(m.seen) > 100_000 {
		for k, t := range m.seen {
			if now.Sub(t) > time.Minute {
				delete(m.seen, k)
			}
		}
	}
	m.mu.Unlock()
	_, err := m.pool.Exec(ctx,
		`INSERT INTO users (id) VALUES ($1) ON CONFLICT (id) DO UPDATE SET last_seen = now()`, id)
	if err != nil {
		slog.Warn("record user", "err", err)
	}
}
