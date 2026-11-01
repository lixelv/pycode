package session

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"

	"github.com/lixelv/polycode/backend/internal/ratelimit"
)

// MCP (Streamable HTTP, stateless, JSON answers) for an agent working with the
// teacher: POST /s/<admin code>/mcp. The code is the credential, as it is for a
// person with that link. The project lives in browsers and this server never
// runs user code, so a tool call is carried to the acting owner's browser
// ({"type":"mcp"}) and its answer ({"type":"mcp-result"}) is handed back. The
// list of tools lives here so a client can connect before anyone opens the page.

//go:embed mcp_tools.json
var mcpToolsJSON []byte

//go:embed mcp_instructions.md
var mcpInstructions string

const (
	// Longer than any wait a tool can ask for (a tournament's check takes up to 3 min).
	mcpCallTimeout = 5 * time.Minute
	mcpMaxBody     = maxFrame - 64<<10 // the call has to fit a WebSocket frame
	mcpLatest      = "2025-06-18"
)

var mcpVersions = []string{mcpLatest, "2025-03-26", "2024-11-05"}

// Calls per session: enough for an agent at work, not enough to flood a teacher's browser.
var mcpLimiter = ratelimit.New(600, time.Minute)

var errNoBrowser = errors.New("no admin has this session open in a browser: the project lives there, so ask the teacher to open the session link")

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

func toolError(message string) map[string]any {
	return map[string]any{"isError": true, "content": []map[string]string{{"type": "text", "text": message}}}
}

// originAllowed: browsers send Origin, so another site cannot drive this
// through a teacher's browser (DNS rebinding included). Agents send none.
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

func (h *Hub) mcp(w http.ResponseWriter, r *http.Request) {
	if !originAllowed(r, h.originPatterns) {
		writeError(w, http.StatusForbidden, "origin not allowed")
		return
	}
	sess, code := h.lookup(w, r)
	if sess == nil {
		return
	}
	if code.Level != LevelAdmin {
		writeError(w, http.StatusForbidden, "MCP needs the session's admin link.")
		return
	}
	if sess.EndedAt != nil {
		writeError(w, http.StatusGone, "This session has ended.")
		return
	}
	if r.Method != http.MethodPost {
		// No server-to-client stream and no sessions (the transport allows both answers).
		w.Header().Set("Allow", "POST")
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, mcpMaxBody))
	if err != nil {
		writeError(w, http.StatusRequestEntityTooLarge, "request too large")
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
	result, rerr := h.mcpMethod(r.Context(), sess, req)
	answer := map[string]any{"jsonrpc": "2.0", "id": req.ID}
	if rerr != nil {
		answer["error"] = rerr
	} else {
		answer["result"] = result
	}
	writeJSON(w, http.StatusOK, answer)
}

func (h *Hub) mcpMethod(ctx context.Context, sess *Session, req rpcRequest) (any, *rpcError) {
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
			"serverInfo":      map[string]string{"name": "polycode", "version": "1.0.0"},
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
		if ok, _ := mcpLimiter.Allow(sess.ID.String()); !ok {
			return toolError("too many calls: wait a minute"), nil
		}
		result, err := h.mcpCall(ctx, sess, params.Name, params.Arguments)
		if err != nil {
			return toolError(err.Error()), nil
		}
		return result, nil
	}
	return nil, &rpcError{-32601, "method not found: " + req.Method}
}

func (h *Hub) mcpCall(ctx context.Context, sess *Session, name string, args json.RawMessage) (json.RawMessage, error) {
	h.mu.Lock()
	rm := h.rooms[sess.ID]
	h.mu.Unlock()
	if rm == nil {
		return nil, errNoBrowser
	}
	if len(args) == 0 {
		args = json.RawMessage("{}")
	}
	ctx, cancel := context.WithTimeout(ctx, mcpCallTimeout)
	defer cancel()
	return rm.mcpCall(ctx, name, args)
}

// mcpPending is one tool call waiting for a browser.
type mcpPending struct {
	peer   uint32
	answer chan mcpAnswer
}

type mcpAnswer struct {
	result json.RawMessage
	err    error
}

// mcpCall sends a call to the acting owner, an admin by definition, and waits.
func (r *room) mcpCall(ctx context.Context, name string, args json.RawMessage) (json.RawMessage, error) {
	r.mu.Lock()
	target := r.members[r.owner]
	if target == nil {
		r.mu.Unlock()
		return nil, errNoBrowser
	}
	r.nextCall++
	id := r.nextCall
	call := &mcpPending{peer: target.info.Peer, answer: make(chan mcpAnswer, 1)}
	if r.calls == nil {
		r.calls = map[uint64]*mcpPending{}
	}
	r.calls[id] = call
	target.enqueueJSON(control{Type: "mcp", ID: id, Name: name, Data: jsonRaw(args)})
	r.mu.Unlock()
	defer func() {
		r.mu.Lock()
		delete(r.calls, id)
		r.mu.Unlock()
	}()
	select {
	case answer := <-call.answer:
		return answer.result, answer.err
	case <-ctx.Done():
		return nil, errors.New("the browser did not answer in time")
	}
}

// mcpResult takes an answer, only from the member the call went to.
func (r *room) mcpResult(from *member, msg control) {
	r.mu.Lock()
	defer r.mu.Unlock()
	call := r.calls[msg.ID]
	if call == nil || call.peer != from.info.Peer {
		return
	}
	delete(r.calls, msg.ID)
	call.answer <- mcpAnswer{result: json.RawMessage(msg.Data)}
}

// mcpGone fails the calls waiting for a member who left. Call with r.mu held.
func (r *room) mcpGone(peer uint32) {
	for id, call := range r.calls {
		if call.peer == peer {
			delete(r.calls, id)
			call.answer <- mcpAnswer{err: errors.New("the browser running this call left the session; the call may or may not have taken effect")}
		}
	}
}
