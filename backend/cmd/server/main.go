// Command server is the polycode backend: user identity, the network
// proxy for in-browser Python, and live-share sessions.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/google/uuid"
	"log/slog"
	"net/http"
	"net/netip"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/lixelv/polycode/backend/internal/db"
	"github.com/lixelv/polycode/backend/internal/identity"
	"github.com/lixelv/polycode/backend/internal/mcp"
	"github.com/lixelv/polycode/backend/internal/projects"
	"github.com/lixelv/polycode/backend/internal/proxy"
	"github.com/lixelv/polycode/backend/internal/ratelimit"
	"github.com/lixelv/polycode/backend/internal/session"
	"github.com/lixelv/polycode/backend/internal/storage"
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

	pool, err := db.Open(ctx, env("DATABASE_URL", "postgres://polycode:polycode@localhost:5432/polycode?sslmode=disable"))
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

	s3, err := storage.New(ctx, storage.Config{
		Endpoint:       os.Getenv("S3_ENDPOINT"),
		PublicEndpoint: env("S3_PUBLIC_ENDPOINT", os.Getenv("S3_ENDPOINT")),
		Bucket:         os.Getenv("S3_BUCKET"),
		AccessKey:      os.Getenv("S3_ACCESS_KEY"),
		SecretKey:      os.Getenv("S3_SECRET_KEY"),
		Region:         env("S3_REGION", "us-east-1"),
		UseSSL:         env("S3_USE_SSL", "true") == "true",
	})
	if err != nil {
		slog.Error("s3", "err", err)
		os.Exit(1)
	}
	if origin, dev := os.LookupEnv("S3_DEV_BUCKET_ORIGIN"); dev {
		// The local S3 may still be starting.
		for attempt := 0; ; attempt++ {
			if err = s3.EnsureDevBucket(ctx, origin); err == nil || attempt == 30 {
				break
			}
			time.Sleep(time.Second)
		}
		if err != nil {
			slog.Error("s3 bucket", "err", err)
			os.Exit(1)
		}
	}

	hub := session.NewHub(pool, origins)
	go hub.Janitor(ctx)
	registry := mcp.NewRegistry()
	projectAPI := projects.NewHandlers(projects.NewStore(pool), s3, hub)
	projectAPI.OnDelete(func(id uuid.UUID) {
		hub.CloseProject(id)
		registry.ProjectGone(id)
	})
	go projectAPI.Janitor(ctx)
	agent := mcp.NewServer(mcp.Config{
		Pool:           pool,
		Projects:       projects.NewStore(pool),
		Registry:       registry,
		OriginPatterns: origins,
		DeleteProject:  projectAPI.Delete,
	})

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/me", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"id": identity.Public(identity.FromContext(r.Context()))})
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
	projectAPI.Register(mux)
	agent.RegisterAPI(mux)

	// The token says who an agent is: it stays outside the cookie's middleware.
	root := http.NewServeMux()
	root.Handle("/mcp", agent)
	root.Handle("/", identity.NewMiddleware(pool).Wrap(mux))

	srv := &http.Server{
		Addr:              env("LISTEN_ADDR", ":8090"),
		Handler:           root,
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
