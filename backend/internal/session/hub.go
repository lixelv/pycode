package session

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"slices"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lixelv/polycode/backend/internal/identity"
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
	mux.HandleFunc("GET /api/sessions/{code}/codes", h.codes)
	mux.HandleFunc("POST /api/sessions/{code}/roles", h.addRole)
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

// grant is what a member may do: a level and custom roles.
type grant struct {
	Level string
	Roles []string
}

// grantOf is what a user gets in a session: the owner is always an admin;
// a role given during the session wins over the join code.
func (h *Hub) grantOf(ctx context.Context, s *Session, code Code, user uuid.UUID) (g grant, owner bool) {
	if user == s.OwnerID {
		return grant{Level: LevelAdmin, Roles: []string{}}, true
	}
	if given, ok := h.store.MemberGrant(ctx, s.ID, user); ok {
		return given, false
	}
	g = grant{Level: code.Level, Roles: []string{}}
	if validRole(code.Role) {
		g.Roles = []string{code.Role}
	}
	return g, false
}

var roleName = regexp.MustCompile(`^[\p{L}\p{N}_-]{1,32}$`)

// validRole accepts a custom role name (not one of the built-in ones).
func validRole(name string) bool {
	switch name {
	case RoleOwner, RoleAdmin, RoleWrite, RoleRead:
		return false
	}
	return roleName.MatchString(name)
}

func validCustom(c Code) bool {
	return validRole(c.Role) && (c.Level == LevelRead || c.Level == LevelWrite)
}

func (h *Hub) create(w http.ResponseWriter, r *http.Request) {
	var body struct {
		AskName bool `json:"askName"`
		Roles   []struct {
			Name  string `json:"name"`
			Level string `json:"level"`
		} `json:"roles"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	roles := make([]Code, 0, len(body.Roles))
	for _, ro := range body.Roles {
		c := Code{Role: ro.Name, Level: ro.Level}
		if !validCustom(c) {
			writeError(w, http.StatusBadRequest, "invalid role: "+ro.Name)
			return
		}
		roles = append(roles, c)
	}
	user := identity.FromContext(r.Context())
	sess, codes, err := h.store.Create(r.Context(), user, body.AskName, roles)
	if err != nil {
		slog.Error("create session", "err", err)
		writeError(w, http.StatusInternalServerError, "could not create the session")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"session": sess, "level": LevelAdmin, "roles": []string{}, "owner": true, "codes": codes})
}

func (h *Hub) lookup(w http.ResponseWriter, r *http.Request) (*Session, Code) {
	sess, code, err := h.store.ByCode(r.Context(), r.PathValue("code"))
	if errors.Is(err, ErrNotFound) {
		writeError(w, http.StatusNotFound, "No session with this code.")
		return nil, code
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "lookup failed")
		return nil, code
	}
	return sess, code
}

func (h *Hub) get(w http.ResponseWriter, r *http.Request) {
	sess, code := h.lookup(w, r)
	if sess == nil {
		return
	}
	g, owner := h.grantOf(r.Context(), sess, code, identity.FromContext(r.Context()))
	writeJSON(w, http.StatusOK, map[string]any{"session": sess, "level": g.Level, "roles": g.Roles, "owner": owner})
}

// setRole changes a connected member's level and custom roles (see
// canSetRole) and keeps them for the rest of the session.
func (h *Hub) setRole(ctx context.Context, sess *Session, rm *room, from *member, msg control) {
	target := rm.member(msg.To)
	refuse := func(why string) { from.enqueueJSON(control{Type: "error", Error: why}) }
	if target == nil || target == from {
		refuse("No such member.")
		return
	}
	if msg.Level != LevelRead && msg.Level != LevelWrite && msg.Level != LevelAdmin {
		refuse("No such level.")
		return
	}
	codes, err := h.store.Codes(ctx, sess.ID)
	if err != nil {
		refuse("Could not change the role.")
		return
	}
	custom := map[string]bool{}
	for _, c := range codes {
		if validRole(c.Role) {
			custom[c.Role] = true
		}
	}
	roles := []string{}
	for _, r := range msg.Roles {
		if !custom[r] {
			refuse("No such role: " + r)
			return
		}
		if !slices.Contains(roles, r) {
			roles = append(roles, r)
		}
	}
	if !canSetRole(from.info.Level, from.user == sess.OwnerID, target.info.Level, target.user == sess.OwnerID, msg.Level) {
		refuse("You cannot change this member's role.")
		return
	}
	g := grant{Level: msg.Level, Roles: roles}
	if err := h.store.SetMemberGrant(ctx, sess.ID, target.user, g); err != nil {
		refuse("Could not change the role.")
		return
	}
	rm.setRole(target.info.Peer, g)
}

// manager reports whether the user may manage the session's roles: the
// owner, or someone connected to it as an admin.
func (h *Hub) manager(sess *Session, user uuid.UUID) bool {
	if user == sess.OwnerID {
		return true
	}
	h.mu.Lock()
	rm := h.rooms[sess.ID]
	h.mu.Unlock()
	return rm != nil && rm.hasAdmin(user)
}

func (h *Hub) codes(w http.ResponseWriter, r *http.Request) {
	sess, _ := h.lookup(w, r)
	if sess == nil {
		return
	}
	if !h.manager(sess, identity.FromContext(r.Context())) {
		writeError(w, http.StatusForbidden, "Only the owner or an admin can see the codes.")
		return
	}
	codes, err := h.store.Codes(r.Context(), sess.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not list the codes")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"codes": codes})
}

func (h *Hub) addRole(w http.ResponseWriter, r *http.Request) {
	sess, _ := h.lookup(w, r)
	if sess == nil {
		return
	}
	if !h.manager(sess, identity.FromContext(r.Context())) {
		writeError(w, http.StatusForbidden, "Only the owner or an admin can add roles.")
		return
	}
	var body struct {
		Name  string `json:"name"`
		Level string `json:"level"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	c := Code{Role: body.Name, Level: body.Level}
	if !validCustom(c) {
		writeError(w, http.StatusBadRequest, "invalid role")
		return
	}
	c, err := h.store.AddRole(r.Context(), sess.ID, c)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not add the role")
		return
	}
	writeJSON(w, http.StatusOK, c)
}

func (h *Hub) end(w http.ResponseWriter, r *http.Request) {
	sess, _ := h.lookup(w, r)
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
	sess, code := h.lookup(w, r)
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
	g, owner := h.grantOf(r.Context(), sess, code, user)
	m := &member{
		info: peerInfo{UserID: identity.Public(user)},
		user: user,
		code: code.Code,
		conn: conn,
		send: make(chan outFrame, sendQueueLen),
	}
	m.info.Level, m.info.Roles, m.info.Owner = g.Level, g.Roles, owner

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
		if json.Unmarshal(data, &msg) != nil {
			continue
		}
		switch msg.Type {
		case "signal":
			rm.signal(m, msg)
		case "reset":
			rm.reset(m)
		case "setRole":
			h.setRole(ctx, sess, rm, m, msg)
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
