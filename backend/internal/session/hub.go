package session

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lixelv/python-coder/backend/internal/identity"
)

const (
	maxFrame     = 4 << 20
	idleTTL      = 24 * time.Hour
	sendQueueLen = 1024
)

// Hub owns the live rooms and serves the session HTTP API.
type Hub struct {
	store          *Store
	originPatterns []string

	mu    sync.Mutex
	rooms map[uuid.UUID]*room
}

func NewHub(pool *pgxpool.Pool, originPatterns []string) *Hub {
	return &Hub{store: &Store{pool: pool}, originPatterns: originPatterns, rooms: map[uuid.UUID]*room{}}
}

func (h *Hub) Register(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/sessions", h.create)
	mux.HandleFunc("GET /api/sessions/{code}", h.get)
	mux.HandleFunc("POST /api/sessions/{code}/end", h.end)
	mux.HandleFunc("GET /api/sessions/{code}/ws", h.ws)
}

// Janitor keeps live sessions fresh and deletes idle ones.
func (h *Hub) Janitor(ctx context.Context) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		h.mu.Lock()
		live := make([]uuid.UUID, 0, len(h.rooms))
		for id := range h.rooms {
			live = append(live, id)
		}
		h.mu.Unlock()
		if err := h.store.Touch(ctx, live); err != nil {
			slog.Warn("touch sessions", "err", err)
		}
		if n, err := h.store.Expire(ctx, idleTTL); err != nil {
			slog.Warn("expire sessions", "err", err)
		} else if n > 0 {
			slog.Info("expired sessions", "count", n)
		}
	}
}

func (h *Hub) roleOf(s *Session, user uuid.UUID) string {
	switch {
	case user == s.OwnerID:
		return RoleOwner
	case s.Mode == ModeReadWrite:
		return RoleEditor
	default:
		return RoleViewer
	}
}

func (h *Hub) create(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Mode string `json:"mode"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxFrame*2)).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if body.Mode != ModeReadOnly && body.Mode != ModeReadWrite {
		writeError(w, http.StatusBadRequest, "mode must be read_only or read_write")
		return
	}
	sess, err := h.store.Create(r.Context(), identity.FromContext(r.Context()), body.Mode)
	if err != nil {
		slog.Error("create session", "err", err)
		writeError(w, http.StatusInternalServerError, "could not create the session")
		return
	}
	writeJSON(w, http.StatusCreated, h.view(sess, identity.FromContext(r.Context())))
}

func (h *Hub) view(s *Session, user uuid.UUID) map[string]any {
	return map[string]any{"session": s, "role": h.roleOf(s, user)}
}

func (h *Hub) lookup(w http.ResponseWriter, r *http.Request) *Session {
	sess, err := h.store.ByCode(r.Context(), r.PathValue("code"))
	if errors.Is(err, ErrNotFound) {
		writeError(w, http.StatusNotFound, "No session with this code.")
		return nil
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "lookup failed")
		return nil
	}
	return sess
}

func (h *Hub) get(w http.ResponseWriter, r *http.Request) {
	if sess := h.lookup(w, r); sess != nil {
		writeJSON(w, http.StatusOK, h.view(sess, identity.FromContext(r.Context())))
	}
}

func (h *Hub) end(w http.ResponseWriter, r *http.Request) {
	sess := h.lookup(w, r)
	if sess == nil {
		return
	}
	if sess.OwnerID != identity.FromContext(r.Context()) {
		writeError(w, http.StatusForbidden, "Only the owner can end the session.")
		return
	}
	if err := h.store.End(r.Context(), sess.ID); err != nil {
		writeError(w, http.StatusInternalServerError, "could not end the session")
		return
	}
	h.mu.Lock()
	rm := h.rooms[sess.ID]
	delete(h.rooms, sess.ID)
	h.mu.Unlock()
	if rm != nil {
		rm.end()
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Hub) ws(w http.ResponseWriter, r *http.Request) {
	sess := h.lookup(w, r)
	if sess == nil {
		return
	}
	if sess.EndedAt != nil {
		writeError(w, http.StatusGone, "This session has ended.")
		return
	}
	user := identity.FromContext(r.Context())
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: h.originPatterns})
	if err != nil {
		return
	}
	conn.SetReadLimit(maxFrame)
	m := &member{
		info: peerInfo{UserID: user.String(), Role: h.roleOf(sess, user)},
		user: user,
		conn: conn,
		send: make(chan outFrame, sendQueueLen),
	}

	h.mu.Lock()
	rm := h.rooms[sess.ID]
	if rm == nil {
		rm = &room{session: sess, members: map[uint32]*member{}}
		h.rooms[sess.ID] = rm
	}
	h.mu.Unlock()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rm.join(m)

	go func() { // writer
		defer cancel()
		for f := range m.send {
			wctx, wcancel := context.WithTimeout(ctx, 10*time.Second)
			kind := websocket.MessageText
			if f.binary {
				kind = websocket.MessageBinary
			}
			err := conn.Write(wctx, kind, f.data)
			wcancel()
			if err != nil {
				return
			}
		}
		conn.Close(websocket.StatusNormalClosure, "session ended")
	}()

	for {
		kind, data, err := conn.Read(ctx)
		if err != nil {
			break
		}
		if kind == websocket.MessageBinary {
			rm.relay(m, data)
			continue
		}
		var msg control
		if json.Unmarshal(data, &msg) == nil && msg.Type == "signal" {
			rm.signal(m, msg)
		}
	}

	if rm.leave(m) {
		h.mu.Lock()
		if h.rooms[sess.ID] == rm {
			rm.mu.Lock()
			if len(rm.members) == 0 {
				delete(h.rooms, sess.ID)
			}
			rm.mu.Unlock()
		}
		h.mu.Unlock()
	}
	conn.CloseNow()
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func mustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}
