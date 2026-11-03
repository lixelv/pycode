package mcp

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lixelv/polycode/backend/internal/db"
	"github.com/lixelv/polycode/backend/internal/identity"
	"github.com/lixelv/polycode/backend/internal/projects"
)

// Integration tests: a real Postgres (TEST_DATABASE_URL, skipped without it), a
// real HTTP server and real tab WebSockets, speaking only the plan's protocol.

const (
	textNoTabs     = "Нет открытых вкладок /mcp-driven"
	textOpen       = "Вызови open_project(project, tab_id)"
	textClosed     = "вкладка закрылась, вызов мог выполниться или нет"
	textSwitching  = "вкладка переключается, повтори"
	textBusyPrefix = "Проект открыт во вкладке "
)

type env struct {
	t       *testing.T
	pool    *pgxpool.Pool
	srv     *httptest.Server
	mu      sync.Mutex
	deleted []uuid.UUID
}

func setup(t *testing.T, tweak ...func(*Config)) *env {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	pool, err := db.Open(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	e := &env{t: t, pool: pool}
	cfg := Config{
		Pool:           pool,
		Projects:       projects.NewStore(pool),
		Registry:       NewRegistry(),
		OriginPatterns: []string{"allowed.example"},
		// delete_project goes through the projects package; S3 is covered there.
		DeleteProject: func(ctx context.Context, owner, id uuid.UUID) error {
			e.mu.Lock()
			e.deleted = append(e.deleted, id)
			e.mu.Unlock()
			_, err := pool.Exec(ctx, `UPDATE projects SET deleted_at = now() WHERE id = $1 AND owner_id = $2`, id, owner)
			return err
		},
	}
	for _, f := range tweak {
		f(&cfg)
	}
	server := NewServer(cfg)
	api := http.NewServeMux()
	server.RegisterAPI(api)
	root := http.NewServeMux()
	root.Handle("/mcp", server) // outside the identity middleware
	root.Handle("/api/", identity.NewMiddleware(pool).Wrap(api))
	e.srv = httptest.NewServer(root)
	t.Cleanup(e.srv.Close)
	return e
}

// ---- people ------------------------------------------------------------------------

type user struct {
	e     *env
	id    uuid.UUID
	token string
}

func (e *env) newUser() *user {
	e.t.Helper()
	u := &user{e: e, id: uuid.Must(uuid.NewV7())}
	u.token = u.reissue()
	return u
}

// reissue is the button on /mcp-driven: POST /api/mcp/token → {token}.
func (u *user) reissue() string {
	u.e.t.Helper()
	req, _ := http.NewRequest("POST", u.e.srv.URL+"/api/mcp/token", nil)
	req.AddCookie(&http.Cookie{Name: "pc_uid", Value: u.id.String()})
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		u.e.t.Fatal(err)
	}
	defer resp.Body.Close()
	var body struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil || body.Token == "" {
		u.e.t.Fatalf("token: %d %v", resp.StatusCode, err)
	}
	return body.Token
}

// ---- the MCP client ----------------------------------------------------------------

type rpcAnswer struct {
	Status  int
	Session string
	Result  json.RawMessage `json:"result"`
	Error   json.RawMessage `json:"error"`
}

func (e *env) post(token, session, origin string, body any) rpcAnswer {
	e.t.Helper()
	data, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", e.srv.URL+"/mcp", bytes.NewReader(data))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if session != "" {
		req.Header.Set("Mcp-Session-Id", session)
	}
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var a rpcAnswer
	_ = json.Unmarshal(raw, &a)
	a.Status = resp.StatusCode
	a.Session = resp.Header.Get("Mcp-Session-Id")
	return a
}

func rpc(method string, params any) map[string]any {
	return map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
}

// initialize opens an MCP session and returns its id.
func (u *user) initialize() string {
	u.e.t.Helper()
	a := u.e.post(u.token, "", "", rpc("initialize", map[string]any{"protocolVersion": "2025-06-18"}))
	if a.Status != http.StatusOK || a.Session == "" {
		u.e.t.Fatalf("initialize: %d, session %q", a.Status, a.Session)
	}
	return a.Session
}

type block struct {
	Type     string `json:"type"`
	Text     string `json:"text,omitempty"`
	Data     string `json:"data,omitempty"`
	MimeType string `json:"mimeType,omitempty"`
}

type toolResult struct {
	Content []block `json:"content"`
	IsError bool    `json:"isError"`
}

func (r toolResult) all() string {
	var parts []string
	for _, b := range r.Content {
		parts = append(parts, b.Text)
	}
	return strings.Join(parts, "\n")
}

// call is one tools/call in an MCP session ("" = no Mcp-Session-Id header).
func (u *user) call(session, name string, args map[string]any) toolResult {
	u.e.t.Helper()
	a := u.e.post(u.token, session, "", rpc("tools/call", map[string]any{"name": name, "arguments": args}))
	if a.Status != http.StatusOK {
		u.e.t.Fatalf("%s: HTTP %d", name, a.Status)
	}
	var r toolResult
	if err := json.Unmarshal(a.Result, &r); err != nil {
		u.e.t.Fatalf("%s: %v: %s %s", name, err, a.Result, a.Error)
	}
	return r
}

func (u *user) mustOK(session, name string, args map[string]any) toolResult {
	u.e.t.Helper()
	r := u.call(session, name, args)
	if r.IsError {
		u.e.t.Fatalf("%s failed: %s", name, r.all())
	}
	return r
}

func wantError(t *testing.T, r toolResult, text string) {
	t.Helper()
	if !r.IsError || !strings.Contains(r.all(), text) {
		t.Fatalf("want an error with %q, got %+v", text, r)
	}
}

type projectRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// createProject goes through the tool, which needs no browser.
func (u *user) createProject(name string) projectRef {
	u.e.t.Helper()
	r := u.mustOK("", "create_project", map[string]any{"project": name})
	var p projectRef
	if err := json.Unmarshal([]byte(r.Content[0].Text), &p); err != nil || p.ID == "" || p.Name != name {
		u.e.t.Fatalf("create_project answered %s: %v", r.Content[0].Text, err)
	}
	return p
}

// ---- a tab ---------------------------------------------------------------------------

type frame struct {
	Type    string          `json:"type"`
	ID      json.RawMessage `json:"id"`
	Name    string          `json:"name"`
	Args    json.RawMessage `json:"args"`
	Project json.RawMessage `json:"project"`
	OK      bool            `json:"ok"`
	Tab     string          `json:"tab"`
}

// projectID reads the project of a frame: an id, or an object with one.
func (f frame) projectID() string {
	var id string
	if json.Unmarshal(f.Project, &id) == nil {
		return id
	}
	var ref projectRef
	_ = json.Unmarshal(f.Project, &ref)
	return ref.ID
}

// tab is a /mcp-driven page: its control socket, frames by arrival.
type tab struct {
	u      *user
	id     string
	conn   *websocket.Conn
	frames chan frame
	closed chan struct{}
}

func (u *user) openTab(id string) *tab {
	u.e.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	target := "ws" + strings.TrimPrefix(u.e.srv.URL, "http") + "/api/mcp/tabs/ws?tab=" + id
	conn, _, err := websocket.Dial(ctx, target, &websocket.DialOptions{HTTPHeader: http.Header{"Cookie": {"pc_uid=" + u.id.String()}}})
	if err != nil {
		u.e.t.Fatal(err)
	}
	conn.SetReadLimit(4 << 20)
	tb := &tab{u: u, id: id, conn: conn, frames: make(chan frame, 64), closed: make(chan struct{})}
	go func() {
		defer close(tb.closed)
		for {
			_, data, err := conn.Read(context.Background())
			if err != nil {
				return
			}
			var f frame
			if json.Unmarshal(data, &f) == nil {
				tb.frames <- f
			}
		}
	}()
	u.e.t.Cleanup(func() { _ = conn.CloseNow() })
	return tb
}

func (tb *tab) send(v any) {
	tb.u.e.t.Helper()
	data, _ := json.Marshal(v)
	if err := tb.conn.Write(context.Background(), websocket.MessageText, data); err != nil {
		tb.u.e.t.Fatal(err)
	}
}

// next waits for a frame of a type, skipping others (such as "projects").
func (tb *tab) next(kind string) frame {
	tb.u.e.t.Helper()
	timeout := time.After(5 * time.Second)
	for {
		select {
		case f := <-tb.frames:
			if f.Type == kind {
				return f
			}
		case <-timeout:
			tb.u.e.t.Fatalf("tab %s: no %q frame", tb.id, kind)
		}
	}
}

// claim takes a project and reports it open.
func (tb *tab) claim(project string) {
	tb.u.e.t.Helper()
	tb.send(map[string]any{"type": "claim", "project": project})
	if f := tb.next("claimed"); !f.OK {
		tb.u.e.t.Fatalf("claim of %s refused, held by %q", project, f.Tab)
	}
	tb.send(map[string]any{"type": "ready", "project": project})
}

func (tb *tab) answer(call frame, result any) {
	tb.u.e.t.Helper()
	tb.send(map[string]any{"type": "result", "id": call.ID, "data": result})
}

func textResult(text string) toolResult {
	return toolResult{Content: []block{{Type: "text", Text: text}}}
}

// serve answers every call with a JSON object naming this tab, so a test sees
// who ran it.
func (tb *tab) serve() {
	go func() {
		for f := range tb.frames {
			if f.Type != "call" {
				continue
			}
			data, _ := json.Marshal(map[string]any{"type": "result", "id": f.ID, "data": textResult(`{"ranOn":"` + tb.id + `","name":"` + f.Name + `"}`)})
			_ = tb.conn.Write(context.Background(), websocket.MessageText, data)
		}
	}()
}

// asyncCall runs a tools/call in the background.
func (u *user) asyncCall(session, name string, args map[string]any) chan toolResult {
	done := make(chan toolResult, 1)
	go func() {
		data, _ := json.Marshal(rpc("tools/call", map[string]any{"name": name, "arguments": args}))
		req, _ := http.NewRequest("POST", u.e.srv.URL+"/mcp", bytes.NewReader(data))
		req.Header.Set("Authorization", "Bearer "+u.token)
		if session != "" {
			req.Header.Set("Mcp-Session-Id", session)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			done <- toolResult{IsError: true, Content: []block{{Type: "text", Text: err.Error()}}}
			return
		}
		defer resp.Body.Close()
		var a rpcAnswer
		_ = json.NewDecoder(resp.Body).Decode(&a)
		var r toolResult
		_ = json.Unmarshal(a.Result, &r)
		done <- r
	}()
	return done
}

func await(t *testing.T, ch chan toolResult) toolResult {
	t.Helper()
	select {
	case r := <-ch:
		return r
	case <-time.After(10 * time.Second):
		t.Fatal("the call did not finish")
		return toolResult{}
	}
}

// ---- token and transport -----------------------------------------------------------

func TestNoTokenIs401(t *testing.T) {
	e := setup(t)
	u := e.newUser()
	ping := rpc("ping", map[string]any{})
	if a := e.post("", "", "", ping); a.Status != http.StatusUnauthorized {
		t.Errorf("no token: got %d, want 401", a.Status)
	}
	if a := e.post("wrong-token", "", "", ping); a.Status != http.StatusUnauthorized {
		t.Errorf("wrong token: got %d, want 401", a.Status)
	}
	// Basic is not Bearer; the cookie is no way in either.
	req, _ := http.NewRequest("POST", e.srv.URL+"/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"ping"}`))
	req.Header.Set("Authorization", "Basic "+u.token)
	req.AddCookie(&http.Cookie{Name: "pc_uid", Value: u.id.String()})
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("Basic with a cookie: got %d, want 401", resp.StatusCode)
	}
	if a := e.post(u.token, "", "", ping); a.Status != http.StatusOK {
		t.Errorf("the right token: got %d", a.Status)
	}
}

func TestUnauthenticatedCallsCreateNoUser(t *testing.T) {
	e := setup(t)
	var before, after int
	ctx := context.Background()
	if err := e.pool.QueryRow(ctx, `SELECT count(*) FROM users`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	for range 3 {
		e.post("", "", "", rpc("ping", map[string]any{}))
	}
	if err := e.pool.QueryRow(ctx, `SELECT count(*) FROM users`).Scan(&after); err != nil {
		t.Fatal(err)
	}
	// Other test packages may add users meanwhile; three of ours would show at least as much.
	if after-before >= 3 {
		t.Fatalf("/mcp created users: %d → %d", before, after)
	}
}

func TestDBHoldsOnlyHash(t *testing.T) {
	e := setup(t)
	u := e.newUser()
	raw, err := hex.DecodeString(u.token)
	if err != nil {
		raw, err = base64.RawURLEncoding.DecodeString(u.token)
	}
	if err != nil || len(raw) != 32 {
		t.Fatalf("token %q should be 32 bytes in hex or base64url (%d, %v)", u.token, len(raw), err)
	}
	var stored []byte
	if err := e.pool.QueryRow(context.Background(), `SELECT mcp_token_hash FROM users WHERE id = $1`, u.id).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	want := sha256.Sum256([]byte(u.token))
	if !bytes.Equal(stored, want[:]) {
		t.Fatalf("mcp_token_hash is not the sha256 of the token: %x", stored)
	}
	var row string
	if err := e.pool.QueryRow(context.Background(), `SELECT u::text FROM users u WHERE id = $1`, u.id).Scan(&row); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(row, u.token) {
		t.Fatalf("the token itself is in the row: %s", row)
	}
}

func TestReissueKillsOldToken(t *testing.T) {
	e := setup(t)
	u := e.newUser()
	old := u.token
	u.token = u.reissue()
	if u.token == old {
		t.Fatal("the same token again")
	}
	if a := e.post(old, "", "", rpc("ping", map[string]any{})); a.Status != http.StatusUnauthorized {
		t.Errorf("old token: got %d, want 401", a.Status)
	}
	if a := e.post(u.token, "", "", rpc("ping", map[string]any{})); a.Status != http.StatusOK {
		t.Errorf("new token: got %d", a.Status)
	}
}

func TestTokenGetDoesNotRevealOrIssue(t *testing.T) {
	e := setup(t)
	u := e.newUser()
	req, _ := http.NewRequest("GET", e.srv.URL+"/api/mcp/token", nil)
	req.AddCookie(&http.Cookie{Name: "pc_uid", Value: u.id.String()})
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET token: %d", resp.StatusCode)
	}
	if strings.Contains(string(body), u.token) {
		t.Fatal("the server gave the token back: it only holds the hash")
	}
	if a := e.post(u.token, "", "", rpc("ping", map[string]any{})); a.Status != http.StatusOK {
		t.Fatal("a GET must not reissue")
	}
}

func TestOriginChecked(t *testing.T) {
	e := setup(t)
	u := e.newUser()
	ping := rpc("ping", map[string]any{})
	if a := e.post(u.token, "", "https://evil.example", ping); a.Status != http.StatusForbidden {
		t.Errorf("foreign origin: got %d, want 403", a.Status)
	}
	if a := e.post(u.token, "", "https://allowed.example", ping); a.Status != http.StatusOK {
		t.Errorf("configured origin: got %d", a.Status)
	}
	if a := e.post(u.token, "", e.srv.URL, ping); a.Status != http.StatusOK {
		t.Errorf("own origin: got %d", a.Status)
	}
	if a := e.post(u.token, "", "", ping); a.Status != http.StatusOK {
		t.Errorf("an agent sends no origin: got %d", a.Status)
	}
}

func TestRateLimit600CallsPerUser(t *testing.T) {
	e := setup(t)
	u, other := e.newUser(), e.newUser()
	const calls = 700
	var ok, limited atomic.Int64
	var wg sync.WaitGroup
	work := make(chan struct{}, calls)
	for range calls {
		work <- struct{}{}
	}
	close(work)
	start := time.Now()
	for range 16 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range work {
				data, _ := json.Marshal(rpc("tools/call", map[string]any{"name": "list_tabs", "arguments": map[string]any{}}))
				req, _ := http.NewRequest("POST", e.srv.URL+"/mcp", bytes.NewReader(data))
				req.Header.Set("Authorization", "Bearer "+u.token)
				resp, err := http.DefaultClient.Do(req)
				if err != nil {
					continue
				}
				var a rpcAnswer
				_ = json.NewDecoder(resp.Body).Decode(&a)
				resp.Body.Close()
				var r toolResult
				_ = json.Unmarshal(a.Result, &r)
				if r.IsError && strings.Contains(r.all(), "too many calls") {
					limited.Add(1)
				} else {
					ok.Add(1)
				}
			}
		}()
	}
	wg.Wait()
	// A token bucket refills by 10 a second while this runs.
	refill := int64(time.Since(start).Seconds()*10) + 1
	if ok.Load() < 600 || ok.Load() > 600+refill {
		t.Errorf("%d calls passed in %v, want 600 (+%d refilled)", ok.Load(), time.Since(start), refill)
	}
	if limited.Load() == 0 {
		t.Error("nothing was limited")
	}
	// The limit is per user.
	if r := other.call("", "list_tabs", map[string]any{}); r.IsError && strings.Contains(r.all(), "too many calls") {
		t.Error("another user was limited")
	}
}

func TestInitializeAndToolsList(t *testing.T) {
	e := setup(t)
	u := e.newUser()
	a := e.post(u.token, "", "", rpc("initialize", map[string]any{"protocolVersion": "2025-06-18"}))
	var init struct {
		Instructions string `json:"instructions"`
	}
	if err := json.Unmarshal(a.Result, &init); err != nil {
		t.Fatal(err)
	}
	for _, word := range []string{"list_tabs", "list_projects", "tab_id"} {
		if !strings.Contains(init.Instructions, word) {
			t.Errorf("instructions do not mention %s", word)
		}
	}
	a = e.post(u.token, "", "", rpc("tools/list", map[string]any{}))
	var list struct {
		Tools []struct {
			Name string `json:"name"`
		} `json:"tools"`
	}
	if err := json.Unmarshal(a.Result, &list); err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, tool := range list.Tools {
		names = append(names, tool.Name)
	}
	// The 62 browser tools stay, with the 7 of the server beside them.
	if len(names) != 69 {
		t.Errorf("%d tools, want 62 + 7", len(names))
	}
	for _, name := range []string{"polycode_guide", "polycode_tests_guide", "list_tabs", "list_projects", "create_project", "delete_project", "open_project", "read_file", "write_file"} {
		if !slices.Contains(names, name) {
			t.Errorf("tools/list has no %s", name)
		}
	}
}

// ---- registry over the socket ------------------------------------------------------

func TestReconnectSameTabTakesOver(t *testing.T) {
	e := setup(t)
	u := e.newUser()
	p := u.createProject("p")
	old := u.openTab("reload")
	old.claim(p.ID)

	fresh := u.openTab("reload")
	select {
	case <-old.closed:
	case <-time.After(5 * time.Second):
		t.Fatal("the old connection should be pushed out")
	}
	fresh.claim(p.ID) // the reload takes its project again
	fresh.serve()
	session := u.initialize()
	u.mustOK(session, "open_project", map[string]any{"project": p.ID, "tab_id": "reload"})
	r := u.mustOK(session, "read_file", map[string]any{"path": "a.py"})
	if !strings.Contains(r.all(), `"ranOn":"reload"`) {
		t.Fatalf("answer: %s", r.all())
	}
	if tabs := u.mustOK(session, "list_tabs", map[string]any{}); strings.Count(tabs.all(), `"tab_id":"reload"`) != 1 {
		t.Fatalf("one tab expected: %s", tabs.all())
	}
}

func TestProjectTakenDuringReload(t *testing.T) {
	e := setup(t)
	u := e.newUser()
	p := u.createProject("p")
	a := u.openTab("a")
	a.claim(p.ID)
	_ = a.conn.CloseNow()
	<-a.closed

	// Wait for the server to notice the close: b gets the project.
	b := u.openTab("b")
	var taken bool
	for range 50 {
		b.send(map[string]any{"type": "claim", "project": p.ID})
		if f := b.next("claimed"); f.OK {
			taken = true
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if !taken {
		t.Fatal("a closed tab's project should be free")
	}
	back := u.openTab("a")
	back.send(map[string]any{"type": "claim", "project": p.ID})
	if f := back.next("claimed"); f.OK || f.Tab != "b" {
		t.Fatalf("the reloaded tab should learn b holds it: %+v", f)
	}
}

func TestOtherUsersTabCannotClaimOrSeeAProject(t *testing.T) {
	e := setup(t)
	alice, bob := e.newUser(), e.newUser()
	p := alice.createProject("theirs")
	tb := bob.openTab("t")
	tb.send(map[string]any{"type": "claim", "project": p.ID})
	if f := tb.next("claimed"); f.OK {
		t.Fatal("bob's tab claimed alice's project")
	}
	r := bob.mustOK("", "list_projects", map[string]any{})
	if strings.Contains(r.all(), p.ID) {
		t.Fatalf("bob sees alice's project: %s", r.all())
	}
	tb2 := alice.openTab("mine")
	tb2.claim(p.ID)
	if r := bob.mustOK("", "list_tabs", map[string]any{}); strings.Contains(r.all(), "mine") {
		t.Fatalf("bob sees alice's tab: %s", r.all())
	}
	r = bob.call("", "open_project", map[string]any{"project": p.ID, "tab_id": "mine"})
	if !r.IsError || strings.Contains(r.all(), "mine") && strings.Contains(r.all(), "theirs") {
		t.Fatalf("bob opened alice's project: %s", r.all())
	}
}

// ---- errors --------------------------------------------------------------------------

func TestErrorTexts(t *testing.T) {
	e := setup(t)
	u := e.newUser()
	// No tabs at all.
	wantError(t, u.call("", "read_file", map[string]any{"path": "a.py"}), textNoTabs)
	// A tab, but no current tab for this client.
	tb := u.openTab("t")
	tb.send(map[string]any{"type": "ready", "project": nil})
	wantError(t, u.call("", "read_file", map[string]any{"path": "a.py"}), textOpen)
	if r := u.call("", "read_file", map[string]any{"path": "a.py"}); !strings.Contains(r.all(), "list_tabs") || !strings.Contains(r.all(), "list_projects") {
		t.Fatalf("the hint should name list_tabs and list_projects: %s", r.all())
	}
}

func TestTabClosedFailsCallAndResetsCurrent(t *testing.T) {
	e := setup(t)
	u := e.newUser()
	p := u.createProject("p")
	tb := u.openTab("t")
	tb.claim(p.ID)
	other := u.openTab("other") // so the next error is "no current", not "no tabs"
	_ = other
	session := u.initialize()
	u.mustOK(session, "open_project", map[string]any{"project": p.ID, "tab_id": "t"})

	done := u.asyncCall(session, "run_program", map[string]any{"path": "a.py"})
	tb.next("call")
	_ = tb.conn.CloseNow()
	wantError(t, await(t, done), textClosed)
	wantError(t, u.call(session, "read_file", map[string]any{"path": "a.py"}), textOpen)
}

// ---- which tab -----------------------------------------------------------------------

func TestSessionsHaveOwnTab(t *testing.T) {
	e := setup(t)
	u := e.newUser()
	pa, pb := u.createProject("a"), u.createProject("b")
	ta, tb := u.openTab("ta"), u.openTab("tb")
	ta.claim(pa.ID)
	tb.claim(pb.ID)
	ta.serve()
	tb.serve()
	s1, s2 := u.initialize(), u.initialize()
	if s1 == s2 {
		t.Fatal("two initialize calls gave one session id")
	}
	u.mustOK(s1, "open_project", map[string]any{"project": pa.ID, "tab_id": "ta"})
	u.mustOK(s2, "open_project", map[string]any{"project": pb.ID, "tab_id": "tb"})
	for range 3 {
		if r := u.mustOK(s1, "read_file", map[string]any{"path": "x"}); !strings.Contains(r.all(), `"ranOn":"ta"`) {
			t.Fatalf("session 1: %s", r.all())
		}
		if r := u.mustOK(s2, "read_file", map[string]any{"path": "x"}); !strings.Contains(r.all(), `"ranOn":"tb"`) {
			t.Fatalf("session 2: %s", r.all())
		}
	}
	// A third session has not chosen yet.
	wantError(t, u.call(u.initialize(), "read_file", map[string]any{"path": "x"}), textOpen)
	// No header is a session of its own.
	wantError(t, u.call("", "read_file", map[string]any{"path": "x"}), textOpen)
}

func TestNoSessionHeaderSharesTab(t *testing.T) {
	e := setup(t)
	u := e.newUser()
	p := u.createProject("p")
	tb := u.openTab("t")
	tb.claim(p.ID)
	tb.serve()
	u.mustOK("", "open_project", map[string]any{"project": p.ID, "tab_id": "t"})
	if r := u.mustOK("", "read_file", map[string]any{"path": "x"}); !strings.Contains(r.all(), `"ranOn":"t"`) {
		t.Fatalf("answer: %s", r.all())
	}
}

func TestSessionIDOfAnotherUserIsNotTheirs(t *testing.T) {
	e := setup(t)
	alice, bob := e.newUser(), e.newUser()
	p := alice.createProject("p")
	tb := alice.openTab("t")
	tb.claim(p.ID)
	tb.serve()
	session := alice.initialize()
	alice.mustOK(session, "open_project", map[string]any{"project": p.ID, "tab_id": "t"})
	if r := bob.call(session, "read_file", map[string]any{"path": "x"}); !r.IsError || strings.Contains(r.all(), "ranOn") {
		t.Fatalf("bob reached alice's tab with her session id: %s", r.all())
	}
}

// ---- open_project ----------------------------------------------------------------------

func TestOpenProjectAlreadyInThisTab(t *testing.T) {
	e := setup(t)
	u := e.newUser()
	p := u.createProject("p")
	tb := u.openTab("t")
	tb.claim(p.ID)
	r := u.call("", "open_project", map[string]any{"project": p.Name, "tab_id": "t"})
	if r.IsError {
		t.Fatalf("no error expected: %s", r.all())
	}
	select {
	case f := <-tb.frames:
		if f.Type == "open" {
			t.Fatal("the tab should not reload for the project it has")
		}
	case <-time.After(200 * time.Millisecond):
	}
}

func TestOpenProjectInAnotherTab(t *testing.T) {
	e := setup(t)
	u := e.newUser()
	p := u.createProject("p")
	holder := u.openTab("holder")
	holder.claim(p.ID)
	u.openTab("free")
	wantError(t, u.call("", "open_project", map[string]any{"project": p.ID, "tab_id": "free"}), textBusyPrefix+"holder")
}

func TestOpenProjectUnknowns(t *testing.T) {
	e := setup(t)
	u := e.newUser()
	p := u.createProject("p")
	u.openTab("t")
	if r := u.call("", "open_project", map[string]any{"project": p.ID, "tab_id": "nope"}); !r.IsError {
		t.Errorf("unknown tab: %s", r.all())
	}
	if r := u.call("", "open_project", map[string]any{"project": "no such project", "tab_id": "t"}); !r.IsError {
		t.Errorf("unknown project: %s", r.all())
	}
}

// Switching, all the way: the tab is told, reloads, says it is ready, and the call ends.
func TestOpenProjectSwitches(t *testing.T) {
	e := setup(t)
	u := e.newUser()
	from, to := u.createProject("from"), u.createProject("to")
	tb := u.openTab("t")
	tb.claim(from.ID)
	session := u.initialize()
	u.mustOK(session, "open_project", map[string]any{"project": from.ID, "tab_id": "t"})

	done := u.asyncCall(session, "open_project", map[string]any{"project": to.ID, "tab_id": "t"})
	if f := tb.next("open"); f.projectID() != to.ID {
		t.Fatalf("open frame: %+v", f)
	}
	// Both are held meanwhile: the old until released, the new already.
	rival := u.openTab("rival")
	rival.send(map[string]any{"type": "claim", "project": to.ID})
	if f := rival.next("claimed"); f.OK || f.Tab != "t" {
		t.Fatalf("the new project should be taken: %+v", f)
	}
	rival.send(map[string]any{"type": "claim", "project": from.ID})
	if f := rival.next("claimed"); f.OK || f.Tab != "t" {
		t.Fatalf("the old project stays taken until released: %+v", f)
	}

	// The page reloads: new connection, same id, the new project ready.
	_ = tb.conn.CloseNow()
	back := u.openTab("t")
	back.send(map[string]any{"type": "ready", "project": to.ID})
	r := await(t, done)
	if r.IsError {
		t.Fatalf("open_project: %s", r.all())
	}
	if !strings.Contains(r.all(), to.ID) || !strings.Contains(r.all(), `"tab_id":"t"`) {
		t.Fatalf("answer should name the tab and project: %s", r.all())
	}
	// The old project is free now.
	rival.send(map[string]any{"type": "claim", "project": from.ID})
	if f := rival.next("claimed"); !f.OK {
		t.Fatalf("old project not released: %+v", f)
	}
	// The tab is current, on the new project.
	back.serve()
	if r := u.mustOK(session, "read_file", map[string]any{"path": "x"}); !strings.Contains(r.all(), to.ID) {
		t.Fatalf("after the switch: %s", r.all())
	}
}

func TestSwitchingRefusesCalls(t *testing.T) {
	e := setup(t)
	u := e.newUser()
	from, to := u.createProject("from"), u.createProject("to")
	tb := u.openTab("t")
	tb.claim(from.ID)
	worker := u.initialize()
	u.mustOK(worker, "open_project", map[string]any{"project": from.ID, "tab_id": "t"})
	switcher := u.initialize()
	done := u.asyncCall(switcher, "open_project", map[string]any{"project": to.ID, "tab_id": "t"})
	tb.next("open")

	wantError(t, u.call(worker, "read_file", map[string]any{"path": "x"}), textSwitching)
	select {
	case f := <-tb.frames:
		if f.Type == "call" {
			t.Fatal("a call reached the switching tab")
		}
	case <-time.After(100 * time.Millisecond):
	}
	tb.send(map[string]any{"type": "ready", "project": to.ID})
	if r := await(t, done); r.IsError {
		t.Fatalf("open_project: %s", r.all())
	}
}

// The tab could not save its project: it stays, and the call fails.
func TestOpenProjectSaveFailure(t *testing.T) {
	e := setup(t)
	u := e.newUser()
	from, to := u.createProject("from"), u.createProject("to")
	tb := u.openTab("t")
	tb.claim(from.ID)
	session := u.initialize()
	u.mustOK(session, "open_project", map[string]any{"project": from.ID, "tab_id": "t"})
	done := u.asyncCall(session, "open_project", map[string]any{"project": to.ID, "tab_id": "t"})
	tb.next("open")
	tb.send(map[string]any{"type": "open-failed", "error": "could not save"})
	wantError(t, await(t, done), "could not save")

	rival := u.openTab("rival")
	rival.send(map[string]any{"type": "claim", "project": to.ID})
	if f := rival.next("claimed"); !f.OK {
		t.Fatalf("the new project should be free again: %+v", f)
	}
	tb.serve()
	if r := u.mustOK(session, "read_file", map[string]any{"path": "x"}); !strings.Contains(r.all(), from.ID) {
		t.Fatalf("the tab should work on its old project: %s", r.all())
	}
}

func TestOpenProjectTimeout(t *testing.T) {
	e := setup(t, func(c *Config) { c.OpenTimeout = 300 * time.Millisecond })
	u := e.newUser()
	from, to := u.createProject("from"), u.createProject("to")
	tb := u.openTab("t")
	tb.claim(from.ID)
	done := u.asyncCall("", "open_project", map[string]any{"project": to.ID, "tab_id": "t"})
	tb.next("open")
	r := await(t, done) // nobody ever says ready
	if !r.IsError {
		t.Fatalf("a timeout should fail: %s", r.all())
	}
	rival := u.openTab("rival")
	rival.send(map[string]any{"type": "claim", "project": to.ID})
	if f := rival.next("claimed"); !f.OK {
		t.Fatalf("after a timeout the new project is free: %+v", f)
	}
}

// ---- answers carry tab_id and project ---------------------------------------------------

// current sets up a tab with a project as the current one, and returns them.
func current(u *user, name string) (*tab, projectRef, string) {
	u.e.t.Helper()
	p := u.createProject(name)
	tb := u.openTab("t-" + name)
	tb.claim(p.ID)
	session := u.initialize()
	u.mustOK(session, "open_project", map[string]any{"project": p.ID, "tab_id": tb.id})
	return tb, p, session
}

type stamped struct {
	TabID   string     `json:"tab_id"`
	Project projectRef `json:"project"`
}

func assertStamp(t *testing.T, raw string, tabID string, p projectRef) {
	t.Helper()
	var s stamped
	if err := json.Unmarshal([]byte(raw), &s); err != nil {
		t.Fatalf("not JSON: %s", raw)
	}
	if s.TabID != tabID || s.Project.ID != p.ID || s.Project.Name != p.Name {
		t.Fatalf("stamp %+v, want tab %s project %+v", s, tabID, p)
	}
}

func TestCallFrameNamesTheProjectAndArgs(t *testing.T) {
	e := setup(t)
	u := e.newUser()
	tb, p, session := current(u, "p")
	done := u.asyncCall(session, "write_file", map[string]any{"path": "a.py", "content": "x"})
	f := tb.next("call")
	if f.Name != "write_file" || f.projectID() != p.ID || !strings.Contains(string(f.Args), `"path":"a.py"`) {
		t.Fatalf("call frame: %+v, args %s", f, f.Args)
	}
	tb.answer(f, textResult("wrote a.py"))
	await(t, done)
}

func TestStampGoesIntoAJSONBlock(t *testing.T) {
	e := setup(t)
	u := e.newUser()
	tb, p, session := current(u, "p")
	done := u.asyncCall(session, "project_overview", map[string]any{})
	tb.answer(tb.next("call"), textResult(`{"files":3,"tab_id":"forged","project":"forged"}`))
	r := await(t, done)
	if r.IsError || len(r.Content) != 1 {
		t.Fatalf("result: %+v", r)
	}
	assertStamp(t, r.Content[0].Text, tb.id, p)
	if !strings.Contains(r.Content[0].Text, `"files":3`) {
		t.Fatalf("the tool's own fields are gone: %s", r.Content[0].Text)
	}
}

func TestStampIsASeparateBlockBesideAPicture(t *testing.T) {
	e := setup(t)
	u := e.newUser()
	tb, p, session := current(u, "p")
	done := u.asyncCall(session, "read_file", map[string]any{"path": "a.png"})
	tb.answer(tb.next("call"), toolResult{Content: []block{{Type: "image", Data: "AAAA", MimeType: "image/png"}}})
	r := await(t, done)
	if len(r.Content) != 2 || r.Content[0].Type != "image" || r.Content[0].Data != "AAAA" || r.Content[1].Type != "text" {
		t.Fatalf("result: %+v", r)
	}
	assertStamp(t, r.Content[1].Text, tb.id, p)
}

func TestStampIsASeparateBlockBesideText(t *testing.T) {
	e := setup(t)
	u := e.newUser()
	for _, text := range []string{"print(1)\n", "[1, 2]", "12", `"just a string"`} {
		tb, p, session := current(u, "p"+fmt.Sprint(len(text)))
		done := u.asyncCall(session, "read_file", map[string]any{"path": "a.py"})
		tb.answer(tb.next("call"), textResult(text))
		r := await(t, done)
		if len(r.Content) != 2 || r.Content[0].Text != text {
			t.Fatalf("a file's text must stay as it is (%q): %+v", text, r)
		}
		assertStamp(t, r.Content[1].Text, tb.id, p)
	}
}

func TestStampOnAToolError(t *testing.T) {
	e := setup(t)
	u := e.newUser()
	tb, p, session := current(u, "p")
	done := u.asyncCall(session, "read_file", map[string]any{"path": "nope.py"})
	tb.answer(tb.next("call"), toolResult{IsError: true, Content: []block{{Type: "text", Text: "no such file"}}})
	r := await(t, done)
	if !r.IsError || r.Content[0].Text != "no such file" || len(r.Content) != 2 {
		t.Fatalf("result: %+v", r)
	}
	assertStamp(t, r.Content[1].Text, tb.id, p)
}

func TestStampIsTakenWhenTheCallIsSent(t *testing.T) {
	e := setup(t)
	u := e.newUser()
	tb, p, session := current(u, "before")
	done := u.asyncCall(session, "project_overview", map[string]any{})
	f := tb.next("call")
	if _, err := e.pool.Exec(context.Background(), `UPDATE projects SET name = 'after' WHERE id = $1`, p.ID); err != nil {
		t.Fatal(err)
	}
	tb.answer(f, textResult(`{}`))
	assertStamp(t, await(t, done).Content[0].Text, tb.id, p) // still "before"
}

// ---- project tools ---------------------------------------------------------------------

func TestListTabsAndProjects(t *testing.T) {
	e := setup(t)
	u := e.newUser()
	a, b := u.createProject("a"), u.createProject("b")
	tb := u.openTab("t")
	tb.claim(a.ID)
	u.openTab("empty")

	var tabs struct {
		Tabs []struct {
			TabID   string      `json:"tab_id"`
			Project *projectRef `json:"project"`
		} `json:"tabs"`
	}
	if err := json.Unmarshal([]byte(u.mustOK("", "list_tabs", map[string]any{}).Content[0].Text), &tabs); err != nil {
		t.Fatal(err)
	}
	seen := map[string]*projectRef{}
	for _, x := range tabs.Tabs {
		seen[x.TabID] = x.Project
	}
	if len(seen) != 2 || seen["t"] == nil || seen["t"].ID != a.ID || seen["t"].Name != "a" || seen["empty"] != nil {
		t.Fatalf("list_tabs: %+v", tabs)
	}

	var list struct {
		Projects []struct {
			ID    string  `json:"id"`
			Name  string  `json:"name"`
			TabID *string `json:"tab_id"`
		} `json:"projects"`
	}
	if err := json.Unmarshal([]byte(u.mustOK("", "list_projects", map[string]any{}).Content[0].Text), &list); err != nil {
		t.Fatal(err)
	}
	found := 0
	for _, x := range list.Projects {
		switch x.ID {
		case a.ID:
			found++
			if x.TabID == nil || *x.TabID != "t" {
				t.Errorf("project a's tab: %v", x.TabID)
			}
		case b.ID:
			found++
			if x.TabID != nil {
				t.Errorf("project b's tab should be null: %v", *x.TabID)
			}
		}
	}
	if found != 2 {
		t.Fatalf("list_projects: %+v", list)
	}
}

func TestToolsWorkWithoutAnyTab(t *testing.T) {
	e := setup(t)
	u := e.newUser()
	u.createProject("no tab needed")
	u.mustOK("", "list_projects", map[string]any{})
	u.mustOK("", "list_tabs", map[string]any{})
}

func TestCreateProjectValidates(t *testing.T) {
	e := setup(t)
	u := e.newUser()
	u.createProject("taken")
	if r := u.call("", "create_project", map[string]any{"project": "taken"}); !r.IsError {
		t.Errorf("taken name: %s", r.all())
	}
	if r := u.call("", "create_project", map[string]any{"project": ""}); !r.IsError {
		t.Errorf("empty name: %s", r.all())
	}
	if r := u.call("", "create_project", map[string]any{"project": strings.Repeat("я", 101)}); !r.IsError {
		t.Errorf("101 characters: %s", r.all())
	}
}

func TestDeleteProjectLeavesTheTabWithoutOne(t *testing.T) {
	e := setup(t)
	u := e.newUser()
	tb, p, session := current(u, "doomed")
	u.mustOK(session, "delete_project", map[string]any{"project": "doomed"})
	tb.next("none")
	e.mu.Lock()
	deleted := slices.Contains(e.deleted, uuid.MustParse(p.ID))
	e.mu.Unlock()
	if !deleted {
		t.Fatal("delete_project did not go through the projects package")
	}
	if r := u.mustOK(session, "list_projects", map[string]any{}); strings.Contains(r.all(), p.ID) {
		t.Fatalf("still listed: %s", r.all())
	}
	wantError(t, u.call(session, "read_file", map[string]any{"path": "x"}), textOpen)
	// The tab is still there, free.
	if r := u.mustOK(session, "list_tabs", map[string]any{}); !strings.Contains(r.all(), tb.id) || strings.Contains(r.all(), p.ID) {
		t.Fatalf("list_tabs: %s", r.all())
	}
}

func TestProjectNameMatchingSeveralGivesCandidates(t *testing.T) {
	e := setup(t)
	u := e.newUser()
	a := u.createProject("a")
	// A name can be another project's id.
	b := u.createProject(a.ID)
	u.openTab("t")
	r := u.call("", "open_project", map[string]any{"project": a.ID, "tab_id": "t"})
	if !r.IsError || !strings.Contains(r.all(), a.ID) || !strings.Contains(r.all(), b.ID) {
		t.Fatalf("both candidates expected: %s", r.all())
	}
	// By the other's own id there is one match.
	if r := u.call("", "delete_project", map[string]any{"project": b.ID}); r.IsError {
		t.Fatalf("a unique id: %s", r.all())
	}
}
