// Command server is the python-coder backend: user identity, the network
// proxy for in-browser Python, and live-share sessions.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/netip"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/lixelv/python-coder/backend/internal/db"
	"github.com/lixelv/python-coder/backend/internal/identity"
	"github.com/lixelv/python-coder/backend/internal/proxy"
	"github.com/lixelv/python-coder/backend/internal/ratelimit"
	"github.com/lixelv/python-coder/backend/internal/session"
)

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	pool, err := db.Open(ctx, env("DATABASE_URL", "postgres://pycoder:pycoder@localhost:5432/pycoder?sslmode=disable"))
	if err != nil {
		slog.Error("database", "err", err)
		os.Exit(1)
	}
	defer pool.Close()

	// WebSocket origins allowed besides the request's own host, e.g. "localhost:5173".
	var origins []string
	for _, o := range strings.Split(env("ALLOWED_ORIGINS", ""), ",") {
		if o = strings.TrimSpace(o); o != "" {
			origins = append(origins, o)
		}
	}

	var allow []netip.Prefix
	for _, c := range strings.Split(env("PROXY_ALLOW_CIDRS", ""), ",") {
		if c = strings.TrimSpace(c); c != "" {
			p, err := netip.ParsePrefix(c)
			if err != nil {
				slog.Error("PROXY_ALLOW_CIDRS", "err", err)
				os.Exit(1)
			}
			allow = append(allow, p)
		}
	}

	hub := session.NewHub(pool, origins)
	go hub.Janitor(ctx)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/me", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"id": identity.FromContext(r.Context())})
	})
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		if err := pool.Ping(r.Context()); err != nil {
			http.Error(w, "db down", http.StatusServiceUnavailable)
			return
		}
		_, _ = w.Write([]byte("ok"))
	})
	mux.Handle("/api/proxy", proxy.New(ratelimit.New(256, time.Minute), allow))
	hub.Register(mux)

	srv := &http.Server{
		Addr:              env("LISTEN_ADDR", ":8090"),
		Handler:           identity.NewMiddleware(pool).Wrap(mux),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdown)
	}()
	slog.Info("listening", "addr", srv.Addr)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		slog.Error("server", "err", err)
		os.Exit(1)
	}
}
