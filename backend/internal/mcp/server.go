// Package mcp is the agent's way in: MCP over Streamable HTTP, one endpoint per
// user, authorised by the user's token. The project lives in browsers and this
// server never runs user code, so a tool call goes to a /mcp-driven tab over its
// socket; the project tools and the two guides are answered here.
package mcp

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lixelv/polycode/backend/internal/identity"
	"github.com/lixelv/polycode/backend/internal/projects"
	"github.com/lixelv/polycode/backend/internal/ratelimit"
)

//go:embed mcp_tools.json
var mcpToolsJSON []byte

//go:embed mcp_instructions.md
var mcpInstructions string

const (
	// OpenTimeout is how long a tab has to save its project and open another.
	OpenTimeout = 60 * time.Second
	// Longer than any wait a tool can ask for (a tournament's check takes up to 3 min).
	callTimeout = 5 * time.Minute
	maxFrame    = 4 << 20
	maxBody     = maxFrame - 64<<10 // the call has to fit a WebSocket frame
	mcpLatest   = "2025-06-18"
	sendQueue   = 256
	// Forgotten sessions go after a day without a call.
	sessionTTL = 24 * time.Hour
)

var mcpVersions = []string{mcpLatest, "2025-03-26", "2024-11-05"}

var tabID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// rawText: their text is the user's data, kept to the letter; the stamp goes beside it.
var rawText = map[string]bool{"read_file": true}

type Config struct {
	Pool           *pgxpool.Pool
	Projects       *projects.Store
	Registry       *Registry
	OriginPatterns []string
	// DeleteProject goes through the projects package, S3 and all.
	DeleteProject func(ctx context.Context, owner, id uuid.UUID) error
	OpenTimeout   time.Duration
}

type sessionKey struct {
	user uuid.UUID
	id   string
}

type currentEntry struct {
	tab  string
	used time.Time
}

type Server struct {
	cfg     Config
	limiter *ratelimit.Limiter

	mu      sync.Mutex
	current map[sessionKey]currentEntry
}

func NewServer(cfg Config) *Server {
	if cfg.OpenTimeout == 0 {
		cfg.OpenTimeout = OpenTimeout
	}
	return &Server{cfg: cfg, limiter: ratelimit.New(600, time.Minute), current: map[sessionKey]currentEntry{}}
}

// RegisterAPI adds what the page uses, under the cookie: the token and the tab's socket.
func (s *Server) RegisterAPI(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/mcp/token", s.tokenStatus)
	mux.HandleFunc("POST /api/mcp/token", s.reissue)
	mux.HandleFunc("GET /api/mcp/tabs/ws", s.tabSocket)
}

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func toolError(message string) map[string]any {
	return map[string]any{"isError": true, "content": []map[string]string{{"type": "text", "text": message}}}
}

func toolJSON(v any) map[string]any {
	data, _ := json.Marshal(v)
	return map[string]any{"content": []map[string]string{{"type": "text", "text": string(data)}}}
}

// originAllowed: browsers send Origin, so another site cannot drive this
// through a user's browser (DNS rebinding included). Agents send none.
func originAllowed(r *http.Request, patterns []string) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	if strings.EqualFold(u.Host, r.Host) {
		return true
	}
	for _, pattern := range patterns {
		if ok, _ := path.Match(strings.ToLower(pattern), strings.ToLower(u.Host)); ok {
			return true
		}
	}
	return false
}

func hashToken(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}

// authorize finds the user of the bearer token.
func (s *Server) authorize(r *http.Request) (uuid.UUID, bool) {
	token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok || token == "" {
		return uuid.Nil, false
	}
	var user uuid.UUID
	err := s.cfg.Pool.QueryRow(r.Context(), `SELECT id FROM users WHERE mcp_token_hash = $1`, hashToken(token)).Scan(&user)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		slog.Warn("mcp token", "err", err)
	}
	return user, err == nil
}

func (s *Server) tokenStatus(w http.ResponseWriter, r *http.Request) {
	var hash []byte
	err := s.cfg.Pool.QueryRow(r.Context(), `SELECT mcp_token_hash FROM users WHERE id = $1`, identity.FromContext(r.Context())).Scan(&hash)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not read the token"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"exists": hash != nil})
}

// reissue makes a new token and kills the old one. Only its hash is kept.
func (s *Server) reissue(w http.ResponseWriter, r *http.Request) {
	raw := make([]byte, 32)
	_, _ = rand.Read(raw)
	token := hex.EncodeToString(raw)
	_, err := s.cfg.Pool.Exec(r.Context(), `UPDATE users SET mcp_token_hash = $2 WHERE id = $1`, identity.FromContext(r.Context()), hashToken(token))
	if err != nil {
		slog.Error("mcp reissue", "err", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not issue a token"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"token": token})
}

// ServeHTTP is POST /mcp. It stays outside the cookie's middleware: the token
// says who this is, and a request of an agent must not make a new user.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !originAllowed(r, s.cfg.OriginPatterns) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "origin not allowed"})
		return
	}
	user, ok := s.authorize(r)
	if !ok {
		w.Header().Set("WWW-Authenticate", "Bearer")
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "a valid token is needed: Authorization: Bearer <token>, shown on the /mcp-driven page"})
		return
	}
	session := r.Header.Get("Mcp-Session-Id")
	if r.Method == http.MethodDelete {
		s.forget(user, session)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		// No server-to-client stream (the transport allows this answer).
		w.Header().Set("Allow", "POST, DELETE")
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
	if err != nil {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "request too large"})
		return
	}
	var req rpcRequest
	if json.Unmarshal(body, &req) != nil || req.Method == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"jsonrpc": "2.0", "id": nil, "error": rpcError{-32600, "expected one JSON-RPC request"}})
		return
	}
	if len(req.ID) == 0 { // a notification
		w.WriteHeader(http.StatusAccepted)
		return
	}
	if req.Method == "initialize" {
		w.Header().Set("Mcp-Session-Id", uuid.NewString())
	}
	result, rerr := s.method(r.Context(), user, session, req)
	out := map[string]any{"jsonrpc": "2.0", "id": req.ID}
	if rerr != nil {
		out["error"] = rerr
	} else {
		out["result"] = result
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) method(ctx context.Context, user uuid.UUID, session string, req rpcRequest) (any, *rpcError) {
	switch req.Method {
	case "initialize":
		var params struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		_ = json.Unmarshal(req.Params, &params)
		version := mcpLatest
		for _, known := range mcpVersions {
			if known == params.ProtocolVersion {
				version = known
			}
		}
		return map[string]any{
			"protocolVersion": version,
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]string{"name": "polycode", "version": "2.0.0"},
			"instructions":    mcpInstructions,
		}, nil
	case "ping":
		return map[string]any{}, nil
	case "tools/list":
		return map[string]json.RawMessage{"tools": mcpToolsJSON}, nil
	case "tools/call":
		var params struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		if json.Unmarshal(req.Params, &params) != nil || params.Name == "" {
			return nil, &rpcError{-32602, "tools/call needs a name"}
		}
		if ok, _ := s.limiter.Allow(user.String()); !ok {
			return toolError("too many calls: wait a minute"), nil
		}
		key := sessionKey{user, session}
		if tool := serverTools[params.Name]; tool != nil {
			result, err := tool(s, ctx, key, params.Arguments)
			if err != nil {
				return toolError(err.Error()), nil
			}
			return result, nil
		}
		result, err := s.forward(ctx, key, params.Name, params.Arguments)
		if err != nil {
			return toolError(err.Error()), nil
		}
		return result, nil
	}
	return nil, &rpcError{-32601, "method not found: " + req.Method}
}

func (s *Server) forget(user uuid.UUID, session string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.current, sessionKey{user, session})
}

func (s *Server) currentTab(key sessionKey) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	cur, ok := s.current[key]
	if !ok {
		return ""
	}
	cur.used = time.Now()
	s.current[key] = cur
	return cur.tab
}

func (s *Server) setCurrent(key sessionKey, tab string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	for k, cur := range s.current {
		if now.Sub(cur.used) > sessionTTL {
			delete(s.current, k)
		}
	}
	s.current[key] = currentEntry{tab, now}
}

func (s *Server) forgetCurrent(key sessionKey) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.current, key)
}

// forward runs a tool in the session's current tab and stamps the answer with
// the tab and project as they were when the call went out.
func (s *Server) forward(ctx context.Context, key sessionKey, name string, args json.RawMessage) (json.RawMessage, error) {
	if len(s.cfg.Registry.Tabs(key.user)) == 0 {
		s.forgetCurrent(key)
		return nil, errNoTabs
	}
	tab := s.currentTab(key)
	if tab == "" {
		return nil, errNeedOpen
	}
	project, exists, err := s.cfg.Registry.projectOf(key.user, tab)
	if !exists {
		s.forgetCurrent(key)
		return nil, errNeedOpen
	}
	if err != nil {
		return nil, err
	}
	if project == nil {
		return nil, errNeedOpen
	}
	p, err := s.cfg.Projects.Get(ctx, *project)
	if errors.Is(err, projects.ErrNotFound) {
		return nil, errNeedOpen
	}
	if err != nil {
		return nil, errors.New("could not read the project")
	}
	if len(args) == 0 {
		args = json.RawMessage("{}")
	}
	ctx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	data, err := s.cfg.Registry.call(ctx, key.user, tab, p.ID, name, args)
	if err != nil {
		if errors.Is(err, errClosed) {
			s.forgetCurrent(key)
		}
		return nil, err
	}
	return stamp(data, name, tab, p), nil
}

type stampFields struct {
	TabID   string      `json:"tab_id"`
	Project projectName `json:"project"`
}

type projectName struct {
	ID   uuid.UUID `json:"id"`
	Name string    `json:"name"`
}

// stamp says which tab and project answered: two agents can change a tab under
// each other. A JSON object takes the fields; anything else gets a block beside it.
func stamp(data json.RawMessage, tool, tab string, p *projects.Project) json.RawMessage {
	var result map[string]json.RawMessage
	if json.Unmarshal(data, &result) != nil {
		return data
	}
	var content []json.RawMessage
	_ = json.Unmarshal(result["content"], &content)
	fields, _ := json.Marshal(stampFields{tab, projectName{p.ID, p.Name}})
	merged := false
	if len(content) > 0 && !rawText[tool] {
		var first struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		var object map[string]json.RawMessage
		if json.Unmarshal(content[0], &first) == nil && first.Type == "text" && json.Unmarshal([]byte(first.Text), &object) == nil && object != nil {
			var stamped map[string]json.RawMessage
			_ = json.Unmarshal(fields, &stamped)
			for k, v := range stamped {
				object[k] = v
			}
			text, _ := json.Marshal(object)
			content[0], _ = json.Marshal(map[string]string{"type": "text", "text": string(text)})
			merged = true
		}
	}
	if !merged {
		block, _ := json.Marshal(map[string]string{"type": "text", "text": string(fields)})
		content = append(content, block)
	}
	result["content"], _ = json.Marshal(content)
	out, _ := json.Marshal(result)
	return out
}

// ---- the tab's socket --------------------------------------------------------------

type tabFrame struct {
	Type    string          `json:"type"`
	ID      uint64          `json:"id"`
	Project *uuid.UUID      `json:"project"`
	Data    json.RawMessage `json:"data"`
	Error   string          `json:"error"`
}

func (s *Server) tabSocket(w http.ResponseWriter, r *http.Request) {
	tab := r.URL.Query().Get("tab")
	if !tabID.MatchString(tab) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid tab id"})
		return
	}
	user := identity.FromContext(r.Context())
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: s.cfg.OriginPatterns})
	if err != nil {
		return
	}
	conn.SetReadLimit(maxFrame)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	out := make(chan []byte, sendQueue)
	send := func(frame []byte) error {
		select {
		case out <- frame:
			return nil
		default:
			// Too slow to keep up: the page reconnects.
			cancel()
			return errors.New("the tab is not keeping up")
		}
	}
	detach, id := s.cfg.Registry.attach(user, tab, send, cancel)
	defer detach()
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case frame := <-out:
				wctx, wcancel := context.WithTimeout(ctx, 10*time.Second)
				err := conn.Write(wctx, websocket.MessageText, frame)
				wcancel()
				if err != nil {
					cancel()
					return
				}
			}
		}
	}()
	go func() {
		<-ctx.Done()
		conn.CloseNow()
	}()
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		var msg tabFrame
		if json.Unmarshal(bytes.TrimSpace(data), &msg) != nil {
			continue
		}
		switch msg.Type {
		case "claim":
			ok, heldBy := false, ""
			if msg.Project != nil {
				// Only one's own project: a foreign one is told apart from nothing.
				if p, err := s.cfg.Projects.Get(ctx, *msg.Project); err == nil && p.OwnerID == user {
					ok, heldBy = s.cfg.Registry.Claim(user, tab, p.ID)
				}
			}
			frame, _ := json.Marshal(map[string]any{"type": "claimed", "ok": ok, "tab": heldBy})
			_ = send(frame)
		case "release":
			s.cfg.Registry.Release(user, tab)
		case "ready":
			s.cfg.Registry.ready(user, tab, msg.Project)
		case "open-failed":
			s.cfg.Registry.openFailed(user, tab, msg.Error)
		case "result":
			s.cfg.Registry.result(user, tab, id, msg.ID, msg.Data)
		}
	}
}
