package projects

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lixelv/polycode/backend/internal/db"
	"github.com/lixelv/polycode/backend/internal/identity"
	"github.com/lixelv/polycode/backend/internal/storage"
)

// Integration tests: a real Postgres (TEST_DATABASE_URL) and a real MinIO
// (S3_TEST_*). Skipped when either is not set. Users are fresh per test, so a
// shared database is fine.

type fakeSaver struct {
	mu     sync.Mutex
	tokens map[uuid.UUID]string
}

func (f *fakeSaver) IsSaver(project uuid.UUID, token string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return token != "" && f.tokens[project] == token
}

func (f *fakeSaver) set(project uuid.UUID, token string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.tokens[project] = token
}

type env struct {
	t       *testing.T
	srv     *httptest.Server
	pool    *pgxpool.Pool
	s3      *storage.S3
	h       *Handlers
	saver   *fakeSaver
	deleted chan uuid.UUID
}

func setup(t *testing.T) *env {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	endpoint := strings.TrimPrefix(os.Getenv("S3_TEST_ENDPOINT"), "http://")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	if endpoint == "" {
		t.Skip("S3_TEST_ENDPOINT is not set")
	}
	ctx := context.Background()
	pool, err := db.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	s3, err := storage.New(ctx, storage.Config{
		Endpoint:       endpoint,
		PublicEndpoint: endpoint,
		Bucket:         os.Getenv("S3_TEST_BUCKET"),
		AccessKey:      os.Getenv("S3_TEST_ACCESS_KEY"),
		SecretKey:      os.Getenv("S3_TEST_SECRET_KEY"),
		Region:         "us-east-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	e := &env{t: t, pool: pool, s3: s3, saver: &fakeSaver{tokens: map[uuid.UUID]string{}}, deleted: make(chan uuid.UUID, 16)}
	e.h = NewHandlers(NewStore(pool), s3, e.saver)
	e.h.OnDelete(func(id uuid.UUID) { e.deleted <- id })
	mux := http.NewServeMux()
	e.h.Register(mux)
	e.srv = httptest.NewServer(identity.NewMiddleware(pool).Wrap(mux))
	t.Cleanup(e.srv.Close)
	return e
}

type project struct {
	ID        string         `json:"id"`
	Name      string         `json:"name"`
	Settings  map[string]any `json:"settings"`
	Public    bool           `json:"public"`
	SizeBytes int64          `json:"sizeBytes"`
	OwnerID   string         `json:"ownerId"`
	Mine      bool           `json:"mine"`
}

func (p project) uuid(t *testing.T) uuid.UUID {
	t.Helper()
	id, err := uuid.Parse(p.ID)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func newUser() uuid.UUID { return uuid.Must(uuid.NewV7()) }

// do sends a request as a user; every user is the cookie they hold.
func (e *env) do(user uuid.UUID, method, path string, body any) (int, []byte) {
	e.t.Helper()
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			e.t.Fatal(err)
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequest(method, e.srv.URL+path, reader)
	if err != nil {
		e.t.Fatal(err)
	}
	req.AddCookie(&http.Cookie{Name: "pc_uid", Value: user.String()})
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, data
}

func (e *env) create(user uuid.UUID, name string) project {
	e.t.Helper()
	status, data := e.do(user, "POST", "/api/projects", map[string]any{"name": name})
	if status != http.StatusOK && status != http.StatusCreated {
		e.t.Fatalf("create %q: %d %s", name, status, data)
	}
	var p project
	if err := json.Unmarshal(data, &p); err != nil {
		e.t.Fatal(err)
	}
	e.t.Cleanup(func() {
		_ = e.s3.DeletePrefix(context.Background(), "projects/"+p.ID+"/")
	})
	return p
}

func (e *env) get(user uuid.UUID, id string) (int, project) {
	e.t.Helper()
	status, data := e.do(user, "GET", "/api/projects/"+id, nil)
	var p project
	_ = json.Unmarshal(data, &p)
	return status, p
}

func (e *env) setPublic(user uuid.UUID, id string, public bool) {
	e.t.Helper()
	status, data := e.do(user, "POST", "/api/projects/"+id+"/visibility", map[string]any{"public": public})
	if status >= 300 {
		e.t.Fatalf("visibility: %d %s", status, data)
	}
}

type op struct {
	Op   string `json:"op"`
	Key  string `json:"key"`
	Size *int64 `json:"size,omitempty"`
}

func get(key string) op             { return op{Op: "get", Key: key} }
func del(key string) op             { return op{Op: "delete", Key: key} }
func put(key string, size int64) op { return op{Op: "put", Key: key, Size: &size} }

// presign returns the status, key → URL, and the raw body.
func (e *env) presign(user uuid.UUID, id, token string, ops ...op) (int, map[string]string, []byte) {
	e.t.Helper()
	body := map[string]any{"ops": ops}
	if token != "" {
		body["saverToken"] = token
	}
	status, data := e.do(user, "POST", "/api/projects/"+id+"/presign", body)
	var parsed struct {
		URLs []struct {
			Key string `json:"key"`
			URL string `json:"url"`
		} `json:"urls"`
	}
	_ = json.Unmarshal(data, &parsed)
	urls := map[string]string{}
	for _, u := range parsed.URLs {
		urls[u.Key] = u.URL
	}
	return status, urls, data
}

// saverOf makes the fake hub name a saver for the project.
func (e *env) saverOf(p project) string {
	e.t.Helper()
	token := "token-" + p.ID
	e.saver.set(p.uuid(e.t), token)
	return token
}

func httpSend(t *testing.T, method, target string, body []byte) (int, []byte) {
	t.Helper()
	req, err := http.NewRequest(method, target, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, data
}

func (e *env) raw(p project, key string, data []byte) {
	e.t.Helper()
	if err := e.s3.WriteSmall(context.Background(), "projects/"+p.ID+"/"+key, data); err != nil {
		e.t.Fatal(err)
	}
}

// keys lists a project's objects, relative to its folder, straight from S3.
func (e *env) keys(id string) []string {
	e.t.Helper()
	prefix := "projects/" + id + "/"
	objects, err := e.s3.List(context.Background(), prefix)
	if err != nil {
		e.t.Fatal(err)
	}
	out := []string{}
	for _, o := range objects {
		out = append(out, strings.TrimPrefix(o.Key, prefix))
	}
	sort.Strings(out)
	return out
}

func gz(t *testing.T, v any) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := gzip.NewWriter(&buf)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		t.Fatal(err)
	}
	_ = w.Close()
	return buf.Bytes()
}

type entry struct {
	Path string `json:"path"`
	ID   string `json:"id"`
	Kind string `json:"kind"`
	Size int64  `json:"size"`
	Hash string `json:"hash,omitempty"`
	Mime string `json:"mime,omitempty"`
}

func (e *env) manifest(id, key string) []entry {
	e.t.Helper()
	data, err := e.s3.ReadSmall(context.Background(), "projects/"+id+"/"+key, 1<<20)
	if err != nil {
		e.t.Fatal(err)
	}
	r, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		e.t.Fatal(err)
	}
	var out []entry
	if err := json.NewDecoder(r).Decode(&out); err != nil {
		e.t.Fatal(err)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out
}

func has(list []string, key string) bool {
	for _, k := range list {
		if k == key {
			return true
		}
	}
	return false
}

// ---- projects: list, get, change ------------------------------------------------

func TestCreateListAndNames(t *testing.T) {
	e := setup(t)
	alice, bob := newUser(), newUser()
	p := e.create(alice, "Алгоритмы")
	if p.Public || !p.Mine || p.Name != "Алгоритмы" {
		t.Fatalf("new project: %+v", p)
	}
	id := p.uuid(t)
	if id.Version() != 7 {
		t.Fatalf("id is UUIDv%d, want 7", id.Version())
	}

	for _, name := range []string{"", strings.Repeat("я", 101)} {
		if status, _ := e.do(alice, "POST", "/api/projects", map[string]any{"name": name}); status != http.StatusBadRequest {
			t.Errorf("name of %d characters: got %d, want 400", len([]rune(name)), status)
		}
	}
	// 100 characters, not bytes.
	e.create(alice, strings.Repeat("я", 100))

	if status, _ := e.do(alice, "POST", "/api/projects", map[string]any{"name": "Алгоритмы"}); status != http.StatusConflict {
		t.Errorf("taken name: got %d, want 409", status)
	}
	e.create(bob, "Алгоритмы") // unique per owner

	status, data := e.do(alice, "GET", "/api/projects", nil)
	var list struct {
		Projects []project `json:"projects"`
	}
	if status != http.StatusOK || json.Unmarshal(data, &list) != nil {
		t.Fatalf("list: %d %s", status, data)
	}
	if len(list.Projects) != 2 {
		t.Fatalf("list holds %d projects, want alice's 2: %s", len(list.Projects), data)
	}
}

func TestOwnerIDIsPublicHash(t *testing.T) {
	e := setup(t)
	alice := newUser()
	p := e.create(alice, "p")
	e.setPublic(alice, p.ID, true)
	status, raw := e.do(newUser(), "GET", "/api/projects/"+p.ID, nil)
	if status != http.StatusOK {
		t.Fatalf("public project: %d", status)
	}
	if strings.Contains(string(raw), alice.String()) {
		t.Fatalf("the cookie id leaked: %s", raw)
	}
	var seen project
	_ = json.Unmarshal(raw, &seen)
	if seen.OwnerID != identity.Public(alice) || seen.Mine {
		t.Fatalf("seen by a stranger: %+v", seen)
	}
}

func TestPatchNameAndSettings(t *testing.T) {
	e := setup(t)
	alice := newUser()
	a := e.create(alice, "a")
	e.create(alice, "b")
	status, data := e.do(alice, "PATCH", "/api/projects/"+a.ID, map[string]any{"name": "c", "settings": map[string]any{"askName": true}})
	if status != http.StatusOK {
		t.Fatalf("patch: %d %s", status, data)
	}
	if _, p := e.get(alice, a.ID); p.Name != "c" || p.Settings["askName"] != true {
		t.Fatalf("after patch: %+v", p)
	}
	if status, _ := e.do(alice, "PATCH", "/api/projects/"+a.ID, map[string]any{"name": "b"}); status != http.StatusConflict {
		t.Errorf("rename onto a taken name: got %d, want 409", status)
	}
	if status, _ := e.do(alice, "PATCH", "/api/projects/"+a.ID, map[string]any{"name": ""}); status != http.StatusBadRequest {
		t.Errorf("empty name: got %d, want 400", status)
	}
}

func TestForeignAndPrivateAnswerTheSame404(t *testing.T) {
	e := setup(t)
	alice, bob := newUser(), newUser()
	p := e.create(alice, "private")
	missing := uuid.Must(uuid.NewV7()).String()
	for _, c := range []struct {
		name, method, suffix string
		body                 any
	}{
		{"get", "GET", "", nil},
		{"patch", "PATCH", "", map[string]any{"name": "mine now"}},
		{"delete", "DELETE", "", nil},
		{"presign", "POST", "/presign", map[string]any{"ops": []op{get("public/structure.ybin.gz")}}},
		{"keys", "GET", "/keys", nil},
		{"visibility", "POST", "/visibility", map[string]any{"public": true}},
		{"copy", "POST", "/copy", map[string]any{}},
	} {
		theirs, theirBody := e.do(bob, c.method, "/api/projects/"+p.ID+c.suffix, c.body)
		absent, absentBody := e.do(bob, c.method, "/api/projects/"+missing+c.suffix, c.body)
		if theirs != http.StatusNotFound || absent != http.StatusNotFound {
			t.Errorf("%s: foreign %d, missing %d, want 404 both", c.name, theirs, absent)
		}
		if !bytes.Equal(theirBody, absentBody) {
			t.Errorf("%s tells a foreign project from a missing one: %s / %s", c.name, theirBody, absentBody)
		}
	}
	if status, _ := e.get(alice, p.ID); status != http.StatusOK {
		t.Fatal("the project should be untouched")
	}
	if status, _ := e.do(bob, "GET", "/api/projects/not-a-uuid", nil); status != http.StatusNotFound {
		t.Errorf("malformed id: got %d, want 404", status)
	}
}

// ---- presign: access matrix ----------------------------------------------------

func TestPresignMatrix(t *testing.T) {
	e := setup(t)
	alice, bob := newUser(), newUser()
	p := e.create(alice, "matrix")
	token := e.saverOf(p)
	hiddenKey := "hidden/f/abc.ybin.gz"
	privateKey := "private/structure.ybin.gz"
	sealedKey := "sealed/f/abc.ybin.gz"
	publicKey := "public/structure.ybin.gz"

	// Owner reads the whole project, without a saver token too.
	for _, key := range []string{publicKey, hiddenKey, privateKey, sealedKey} {
		if status, urls, body := e.presign(alice, p.ID, "", get(key)); status != http.StatusOK || urls[key] == "" {
			t.Errorf("owner get %s: %d %s", key, status, body)
		}
	}
	// Private: a stranger gets 404 for anything.
	if status, urls, _ := e.presign(bob, p.ID, "", get(publicKey)); status != http.StatusNotFound || len(urls) != 0 {
		t.Errorf("stranger on a private project: %d %v", status, urls)
	}

	e.setPublic(alice, p.ID, true)
	if status, urls, _ := e.presign(bob, p.ID, "", get(publicKey)); status != http.StatusOK || urls[publicKey] == "" {
		t.Errorf("stranger reads public/: %d %v", status, urls)
	}
	for _, key := range []string{hiddenKey, privateKey, sealedKey, "hidden/manifest.json.gz", "sealed/manifest.json.gz"} {
		if status, urls, _ := e.presign(bob, p.ID, "", get(key)); status != http.StatusNotFound || len(urls) != 0 {
			t.Errorf("stranger get %s of a public project: %d %v", key, status, urls)
		}
	}
	// The saver's token does not make a stranger a writer.
	for _, o := range []op{put(publicKey, 5), del(publicKey)} {
		if status, urls, _ := e.presign(bob, p.ID, token, o); status < 400 || len(urls) != 0 {
			t.Errorf("stranger %s with a stolen token: %d %v", o.Op, status, urls)
		}
	}

	e.setPublic(alice, p.ID, false)
	if status, _, _ := e.presign(bob, p.ID, "", get(publicKey)); status != http.StatusNotFound {
		t.Errorf("after Make private: got %d, want 404", status)
	}
}

func TestPresignWriteNeedsTheCurrentSaverToken(t *testing.T) {
	e := setup(t)
	alice := newUser()
	p := e.create(alice, "saver")
	key := "public/f/abc.ybin.gz"
	for name, token := range map[string]string{"none": "", "wrong": "wrong"} {
		for _, o := range []op{put(key, 3), del(key)} {
			if status, urls, _ := e.presign(alice, p.ID, token, o); status != http.StatusForbidden || len(urls) != 0 {
				t.Errorf("%s with token %s: %d %v", o.Op, name, status, urls)
			}
		}
	}
	old := e.saverOf(p)
	if status, urls, body := e.presign(alice, p.ID, old, put(key, 3)); status != http.StatusOK || urls[key] == "" {
		t.Fatalf("put as the saver: %d %s", status, body)
	}
	if status, urls, body := e.presign(alice, p.ID, old, del(key)); status != http.StatusOK || urls[key] == "" {
		t.Fatalf("delete as the saver: %d %s", status, body)
	}
	// The saver moved: a tab that has not heard of it yet is refused.
	e.saver.set(p.uuid(t), "next")
	if status, _, _ := e.presign(alice, p.ID, old, put(key, 3)); status != http.StatusForbidden {
		t.Errorf("old token: got %d, want 403", status)
	}
}

func TestPresignSealedNeverWritable(t *testing.T) {
	e := setup(t)
	alice := newUser()
	p := e.create(alice, "sealed")
	token := e.saverOf(p)
	for _, key := range []string{"sealed/f/abc.ybin.gz", "sealed/b/" + sha + ".gz", "sealed/manifest.json.gz"} {
		for _, o := range []op{put(key, 3), del(key)} {
			if status, urls, _ := e.presign(alice, p.ID, token, o); status != http.StatusForbidden || len(urls) != 0 {
				t.Errorf("%s %s: %d %v", o.Op, key, status, urls)
			}
		}
	}
}

// Replacing a sealed file must remove its objects and its manifest entry, yet
// the owner may not write sealed/: so the server does it. See the report of Task 1.
func TestSealedRemoveEndpointDropsEntryAndObjects(t *testing.T) {
	e := setup(t)
	alice, bob := newUser(), newUser()
	p := e.create(alice, "replace")
	token := e.saverOf(p)
	e.raw(p, "sealed/manifest.json.gz", gz(t, []entry{
		{Path: "a.test.py", ID: "aaa", Kind: "text", Size: 1},
		{Path: "b.test.py", ID: "bbb", Kind: "text", Size: 1},
		{Path: "c.bin", ID: "ccc", Kind: "binary", Size: 1, Hash: sha},
	}))
	e.raw(p, "sealed/f/aaa.ybin.gz", []byte("a"))
	e.raw(p, "sealed/f/bbb.ybin.gz", []byte("b"))
	e.raw(p, "sealed/b/"+sha+".gz", []byte("c"))

	body := map[string]any{"saverToken": token, "paths": []string{"a.test.py", "c.bin"}}
	if status, _ := e.do(bob, "POST", "/api/projects/"+p.ID+"/sealed/remove", body); status != http.StatusNotFound {
		t.Errorf("stranger: got %d, want 404", status)
	}
	if status, _ := e.do(alice, "POST", "/api/projects/"+p.ID+"/sealed/remove", map[string]any{"paths": []string{"a.test.py"}}); status != http.StatusForbidden {
		t.Errorf("no saver token: got %d, want 403", status)
	}
	if status, data := e.do(alice, "POST", "/api/projects/"+p.ID+"/sealed/remove", body); status >= 300 {
		t.Fatalf("remove: %d %s", status, data)
	}
	keys := e.keys(p.ID)
	if has(keys, "sealed/f/aaa.ybin.gz") || has(keys, "sealed/b/"+sha+".gz") {
		t.Errorf("objects left: %v", keys)
	}
	if !has(keys, "sealed/f/bbb.ybin.gz") {
		t.Errorf("another sealed file went too: %v", keys)
	}
	if got := e.manifest(p.ID, "sealed/manifest.json.gz"); len(got) != 1 || got[0].Path != "b.test.py" {
		t.Errorf("manifest: %+v", got)
	}
}

func TestPresignBadKeysAndOps(t *testing.T) {
	e := setup(t)
	alice := newUser()
	p := e.create(alice, "shape")
	other := e.create(alice, "other")
	token := e.saverOf(p)
	for _, key := range []string{
		"public/../private/structure.ybin.gz",
		"projects/" + other.ID + "/public/structure.ybin.gz",
		"../" + other.ID + "/public/structure.ybin.gz",
		"nonsense",
		"",
	} {
		if status, urls, _ := e.presign(alice, p.ID, token, get(key)); status != http.StatusBadRequest || len(urls) != 0 {
			t.Errorf("key %q: %d %v, want 400", key, status, urls)
		}
	}
	if status, _, _ := e.presign(alice, p.ID, token, op{Op: "list", Key: "public/board.ybin.gz"}); status != http.StatusBadRequest {
		t.Errorf("unknown op: got %d, want 400", status)
	}
	key := "public/board.ybin.gz"
	if status, _, _ := e.presign(alice, p.ID, token, op{Op: "put", Key: key}); status != http.StatusBadRequest {
		t.Errorf("put without a size: got %d, want 400", status)
	}
	if status, _, _ := e.presign(alice, p.ID, token, put(key, -1)); status != http.StatusBadRequest {
		t.Errorf("negative size: got %d, want 400", status)
	}
	// One bad operation refuses the whole request.
	if status, urls, _ := e.presign(alice, p.ID, token, get(key), get("nonsense")); status != http.StatusBadRequest || len(urls) != 0 {
		t.Errorf("mixed request: %d %v", status, urls)
	}
}

func TestPresignAtMost100Ops(t *testing.T) {
	e := setup(t)
	alice := newUser()
	p := e.create(alice, "hundred")
	ops := make([]op, 101)
	for i := range ops {
		ops[i] = get(fmt.Sprintf("public/f/x%d.ybin.gz", i))
	}
	if status, urls, _ := e.presign(alice, p.ID, "", ops...); status != http.StatusBadRequest || len(urls) != 0 {
		t.Errorf("101 ops: %d, %d urls", status, len(urls))
	}
	if status, urls, _ := e.presign(alice, p.ID, "", ops[:100]...); status != http.StatusOK || len(urls) != 100 {
		t.Errorf("100 ops: %d, %d urls", status, len(urls))
	}
}

func TestPresignURLIsInsideTheProjectAndLasts5Minutes(t *testing.T) {
	e := setup(t)
	alice := newUser()
	p := e.create(alice, "url")
	token := e.saverOf(p)
	key := "public/board.ybin.gz"
	for _, o := range []op{get(key), put(key, 10), del(key)} {
		_, urls, body := e.presign(alice, p.ID, token, o)
		u := urls[key]
		if !strings.Contains(u, "/projects/"+p.ID+"/"+key) {
			t.Errorf("%s URL: %s (%s)", o.Op, u, body)
		}
		if !strings.Contains(u, "X-Amz-Expires=300") {
			t.Errorf("%s URL does not last 5 minutes: %s", o.Op, u)
		}
	}
}

// The real thing: a URL works on its object and on nothing else.
func TestPresignedURLsThroughRealS3(t *testing.T) {
	e := setup(t)
	alice, bob := newUser(), newUser()
	a := e.create(alice, "a")
	b := e.create(bob, "b")
	token := e.saverOf(a)
	key := "public/f/abc.ybin.gz"
	data := []byte("project a")

	_, urls, _ := e.presign(alice, a.ID, token, put(key, int64(len(data))))
	if status, _ := httpSend(t, "PUT", urls[key], append(append([]byte{}, data...), 'x')); status < 400 {
		t.Fatalf("PUT of another size: %d", status)
	}
	if has(e.keys(a.ID), key) {
		t.Fatal("wrong size left an object")
	}
	if status, _ := httpSend(t, "PUT", urls[key], data); status != http.StatusOK {
		t.Fatalf("PUT: %d", status)
	}

	e.raw(b, key, []byte("project b"))
	_, urls, _ = e.presign(alice, a.ID, "", get(key))
	if status, got := httpSend(t, "GET", urls[key], nil); status != http.StatusOK || !bytes.Equal(got, data) {
		t.Fatalf("GET: %d %q", status, got)
	}
	cross := strings.Replace(urls[key], a.ID, b.ID, 1)
	if status, got := httpSend(t, "GET", cross, nil); status != http.StatusForbidden || bytes.Contains(got, []byte("project b")) {
		t.Fatalf("URL of A on B: %d %q", status, got)
	}
}

// ---- quotas ----------------------------------------------------------------------

func TestProjectQuota64MB(t *testing.T) {
	e := setup(t)
	alice := newUser()
	p := e.create(alice, "quota")
	token := e.saverOf(p)
	const mb = int64(1 << 20)
	a, b := "public/b/"+strings.Repeat("a", 64)+".gz", "public/b/"+strings.Repeat("b", 64)+".gz"

	if status, urls, body := e.presign(alice, p.ID, token, put(a, 64*mb+1)); status != http.StatusRequestEntityTooLarge || len(urls) != 0 {
		t.Errorf("over 64 MB: %d %s", status, body)
	}
	// Sizes in one request add up.
	if status, urls, _ := e.presign(alice, p.ID, token, put(a, 40*mb), put(b, 40*mb)); status != http.StatusRequestEntityTooLarge || len(urls) != 0 {
		t.Errorf("two puts over 64 MB together: %d", status)
	}
	if status, _, body := e.presign(alice, p.ID, token, put(a, 64*mb)); status != http.StatusOK {
		t.Errorf("exactly 64 MB: %d %s", status, body)
	}
}

func TestQuotaCountsCurrentObjectsWithoutReplacedKeys(t *testing.T) {
	e := setup(t)
	alice := newUser()
	p := e.create(alice, "replace")
	token := e.saverOf(p)
	key := "public/f/abc.ybin.gz"
	stored := make([]byte, 1000)
	_, urls, _ := e.presign(alice, p.ID, token, put(key, 1000))
	if status, _ := httpSend(t, "PUT", urls[key], stored); status != http.StatusOK {
		t.Fatalf("PUT: %d", status)
	}
	// 1000 bytes stored + 64 MB elsewhere is over the limit...
	if status, _, _ := e.presign(alice, p.ID, token, put("public/f/other.ybin.gz", ProjectLimit)); status != http.StatusRequestEntityTooLarge {
		t.Errorf("stored objects not counted: got %d", status)
	}
	// ...but replacing that very object is not.
	if status, _, body := e.presign(alice, p.ID, token, put(key, ProjectLimit)); status != http.StatusOK {
		t.Errorf("replacing a key counted twice: %d %s", status, body)
	}
}

func TestSizeBytesFollowsDeclaredSizes(t *testing.T) {
	e := setup(t)
	alice := newUser()
	p := e.create(alice, "size")
	token := e.saverOf(p)
	key := "public/f/abc.ybin.gz"
	_, urls, _ := e.presign(alice, p.ID, token, put(key, 1000))
	if _, got := e.get(alice, p.ID); got.SizeBytes != 1000 {
		t.Errorf("after presign: sizeBytes %d, want 1000", got.SizeBytes)
	}
	if status, _ := httpSend(t, "PUT", urls[key], make([]byte, 1000)); status != http.StatusOK {
		t.Fatalf("PUT: %d", status)
	}
	e.presign(alice, p.ID, token, put(key, 400), put("public/f/two.ybin.gz", 100))
	if _, got := e.get(alice, p.ID); got.SizeBytes != 500 {
		t.Errorf("after replacing: sizeBytes %d, want 500", got.SizeBytes)
	}
}

func TestUserQuota1GB(t *testing.T) {
	e := setup(t)
	alice := newUser()
	full := e.create(alice, "full")
	p := e.create(alice, "more")
	token := e.saverOf(p)
	const mb = int64(1 << 20)
	if _, err := e.pool.Exec(context.Background(), `UPDATE projects SET size_bytes = $1 WHERE id = $2`, UserLimit-10*mb, full.uuid(t)); err != nil {
		t.Fatal(err)
	}
	key := "public/b/" + sha + ".gz"
	if status, _, _ := e.presign(alice, p.ID, token, put(key, 10*mb+1)); status != http.StatusRequestEntityTooLarge {
		t.Errorf("over 1 GB in all: got %d", status)
	}
	if status, _, body := e.presign(alice, p.ID, token, put(key, 10*mb)); status != http.StatusOK {
		t.Errorf("exactly 1 GB in all: %d %s", status, body)
	}
	// Another user's space is their own.
	bob := newUser()
	theirs := e.create(bob, "theirs")
	if status, _, _ := e.presign(bob, theirs.ID, e.saverOf(theirs), put(key, 10*mb+1)); status != http.StatusOK {
		t.Errorf("another user: got %d", status)
	}
}

// ---- keys, visibility -----------------------------------------------------------

func TestKeysListIsOwnerOnly(t *testing.T) {
	e := setup(t)
	alice, bob := newUser(), newUser()
	p := e.create(alice, "keys")
	e.raw(p, "public/f/a.ybin.gz", []byte("1234"))
	e.raw(p, "hidden/f/h.ybin.gz", []byte("12"))
	e.setPublic(alice, p.ID, true)
	if status, _ := e.do(bob, "GET", "/api/projects/"+p.ID+"/keys", nil); status != http.StatusNotFound {
		t.Errorf("stranger on a public project: got %d, want 404", status)
	}
	status, data := e.do(alice, "GET", "/api/projects/"+p.ID+"/keys", nil)
	var parsed struct {
		Keys []struct {
			Key  string `json:"key"`
			Size int64  `json:"size"`
		} `json:"keys"`
	}
	if status != http.StatusOK || json.Unmarshal(data, &parsed) != nil {
		t.Fatalf("keys: %d %s", status, data)
	}
	got := map[string]int64{}
	for _, k := range parsed.Keys {
		got[k.Key] = k.Size
	}
	if len(got) != 2 || got["public/f/a.ybin.gz"] != 4 || got["hidden/f/h.ybin.gz"] != 2 {
		t.Fatalf("keys should be relative to the project: %s", data)
	}
}

func TestVisibilityOwnerOnly(t *testing.T) {
	e := setup(t)
	alice, bob := newUser(), newUser()
	p := e.create(alice, "vis")
	e.setPublic(alice, p.ID, true)
	if status, _ := e.get(bob, p.ID); status != http.StatusOK {
		t.Fatalf("public: %d", status)
	}
	if status, _ := e.do(bob, "POST", "/api/projects/"+p.ID+"/visibility", map[string]any{"public": false}); status != http.StatusNotFound && status != http.StatusForbidden {
		t.Errorf("a stranger changed visibility: %d", status)
	}
	if status, _ := e.do(bob, "DELETE", "/api/projects/"+p.ID, nil); status != http.StatusNotFound && status != http.StatusForbidden {
		t.Errorf("a stranger deleted a public project: %d", status)
	}
	if status, got := e.get(alice, p.ID); status != http.StatusOK || !got.Public {
		t.Errorf("after a stranger's attempts: %d %+v", status, got)
	}
	e.setPublic(alice, p.ID, false)
	if status, _ := e.get(bob, p.ID); status != http.StatusNotFound {
		t.Errorf("private again: got %d, want 404", status)
	}
}

// ---- deletion --------------------------------------------------------------------

func TestPresignAfterDelete404(t *testing.T) {
	e := setup(t)
	alice, bob := newUser(), newUser()
	p := e.create(alice, "gone")
	token := e.saverOf(p)
	e.setPublic(alice, p.ID, true)
	e.raw(p, "public/f/a.ybin.gz", []byte("x"))

	if status, data := e.do(alice, "DELETE", "/api/projects/"+p.ID, nil); status >= 300 {
		t.Fatalf("delete: %d %s", status, data)
	}
	// Review focus 5: a tab still saving is told, and stops.
	if status, urls, _ := e.presign(alice, p.ID, token, put("public/f/a.ybin.gz", 1)); status != http.StatusNotFound || len(urls) != 0 {
		t.Errorf("owner's presign after delete: %d %v", status, urls)
	}
	if status, _, _ := e.presign(bob, p.ID, "", get("public/f/a.ybin.gz")); status != http.StatusNotFound {
		t.Errorf("stranger's presign after delete: got %d", status)
	}
	if status, _ := e.get(alice, p.ID); status != http.StatusNotFound {
		t.Errorf("get after delete: got %d", status)
	}
	if status, _ := e.do(bob, "POST", "/api/projects/"+p.ID+"/copy", map[string]any{}); status != http.StatusNotFound {
		t.Errorf("copy after delete: got %d", status)
	}
	if got := e.keys(p.ID); len(got) != 0 {
		t.Errorf("objects not deleted at once: %v", got)
	}
	select {
	case id := <-e.deleted:
		if id != p.uuid(t) {
			t.Errorf("OnDelete got %s", id)
		}
	case <-time.After(5 * time.Second):
		t.Error("OnDelete was not called: the room stays open")
	}
	// The name is free again, while the row waits for the janitor.
	e.create(alice, "gone")
}

func TestLatePutSweptByJanitor(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	alice := newUser()
	p := e.create(alice, "late")
	token := e.saverOf(p)
	key := "public/f/late.ybin.gz"
	_, urls, _ := e.presign(alice, p.ID, token, put(key, 4))
	if status, data := e.do(alice, "DELETE", "/api/projects/"+p.ID, nil); status >= 300 {
		t.Fatalf("delete: %d %s", status, data)
	}
	// A URL given out before the delete still works.
	if status, _ := httpSend(t, "PUT", urls[key], []byte("late")); status != http.StatusOK {
		t.Fatalf("late PUT: %d", status)
	}
	if !has(e.keys(p.ID), key) {
		t.Fatal("the late object should be there before the sweep")
	}
	var deletedAt time.Time
	if err := e.pool.QueryRow(ctx, `SELECT deleted_at FROM projects WHERE id = $1`, p.uuid(t)).Scan(&deletedAt); err != nil {
		t.Fatal(err)
	}
	rows := func() int {
		var n int
		if err := e.pool.QueryRow(ctx, `SELECT count(*) FROM projects WHERE id = $1`, p.uuid(t)).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	// Not before 6 minutes: a URL lasts 5, and the sweep must come after the last.
	if err := e.h.Sweep(ctx, deletedAt.Add(6*time.Minute-time.Second)); err != nil {
		t.Fatal(err)
	}
	if !has(e.keys(p.ID), key) || rows() != 1 {
		t.Fatalf("swept early: keys %v, rows %d", e.keys(p.ID), rows())
	}
	if err := e.h.Sweep(ctx, deletedAt.Add(6*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if got := e.keys(p.ID); len(got) != 0 {
		t.Fatalf("after the sweep: %v", got)
	}
	if rows() != 0 {
		t.Fatal("the row should go with the sweep")
	}
}

func TestSweepLeavesLiveProjects(t *testing.T) {
	e := setup(t)
	alice := newUser()
	p := e.create(alice, "alive")
	e.raw(p, "public/f/a.ybin.gz", []byte("x"))
	if err := e.h.Sweep(context.Background(), time.Now().Add(24*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if !has(e.keys(p.ID), "public/f/a.ybin.gz") {
		t.Fatal("the sweep took a live project's object")
	}
	if status, _ := e.get(alice, p.ID); status != http.StatusOK {
		t.Fatalf("live project: %d", status)
	}
}

// ---- copying ---------------------------------------------------------------------

// fill gives a project one object under every prefix, with manifests.
func fill(e *env, p project) {
	t := e.t
	e.raw(p, "public/structure.ybin.gz", []byte("public structure"))
	e.raw(p, "public/board.ybin.gz", []byte("board"))
	e.raw(p, "public/f/pub.ybin.gz", []byte("public text"))
	e.raw(p, "public/b/"+sha+".gz", []byte("public blob"))
	e.raw(p, "hidden/manifest.json.gz", gz(t, []entry{
		{Path: "t.test.py", ID: "hid", Kind: "text", Size: 11},
		{Path: "img.png", ID: "hb", Kind: "binary", Size: 11, Hash: strings.Repeat("c", 64), Mime: "image/png"},
	}))
	e.raw(p, "hidden/f/hid.ybin.gz", []byte("hidden text"))
	e.raw(p, "hidden/b/"+strings.Repeat("c", 64)+".gz", []byte("hidden blob"))
	e.raw(p, "sealed/manifest.json.gz", gz(t, []entry{{Path: "old.test.py", ID: "sea", Kind: "text", Size: 11}}))
	e.raw(p, "sealed/f/sea.ybin.gz", []byte("sealed text"))
	e.raw(p, "private/structure.ybin.gz", []byte("private structure"))
	e.raw(p, "private/f/stu.ybin.gz", []byte("a student's work"))
	e.raw(p, "private/b/"+strings.Repeat("d", 64)+".gz", []byte("private blob"))
	e.raw(p, "private/t/"+tid+".ybin.gz", []byte("table"))
}

func (e *env) copyOf(user uuid.UUID, id string) project {
	e.t.Helper()
	status, data := e.do(user, "POST", "/api/projects/"+id+"/copy", map[string]any{})
	if status != http.StatusOK && status != http.StatusCreated {
		e.t.Fatalf("copy: %d %s", status, data)
	}
	var p project
	if err := json.Unmarshal(data, &p); err != nil {
		e.t.Fatal(err)
	}
	e.t.Cleanup(func() { _ = e.s3.DeletePrefix(context.Background(), "projects/"+p.ID+"/") })
	return p
}

func TestCopyNeverTouchesPrivate(t *testing.T) {
	e := setup(t)
	alice, bob := newUser(), newUser()
	p := e.create(alice, "source")
	fill(e, p)
	e.setPublic(alice, p.ID, true)
	c := e.copyOf(bob, p.ID)
	for _, key := range e.keys(c.ID) {
		if strings.HasPrefix(key, "private/") {
			t.Errorf("copied %s", key)
		}
	}
	// A copy of one's own project too.
	own := e.copyOf(alice, p.ID)
	for _, key := range e.keys(own.ID) {
		if strings.HasPrefix(key, "private/") {
			t.Errorf("copied %s from one's own project", key)
		}
	}
	if !has(e.keys(p.ID), "private/f/stu.ybin.gz") {
		t.Error("the source lost its private files")
	}
}

func TestCopyHiddenBecomesSealed(t *testing.T) {
	e := setup(t)
	alice, bob := newUser(), newUser()
	p := e.create(alice, "source")
	fill(e, p)
	e.setPublic(alice, p.ID, true)
	c := e.copyOf(bob, p.ID)
	if c.ID == p.ID || c.Public || !c.Mine {
		t.Fatalf("a copy is a new private project of the caller: %+v", c)
	}

	want := []string{
		"public/b/" + sha + ".gz",
		"public/board.ybin.gz",
		"public/f/pub.ybin.gz",
		"public/structure.ybin.gz",
		"sealed/b/" + strings.Repeat("c", 64) + ".gz",
		"sealed/f/hid.ybin.gz",
		"sealed/f/sea.ybin.gz",
		"sealed/manifest.json.gz",
	}
	sort.Strings(want)
	if got := e.keys(c.ID); strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("copied keys:\n%s\nwant:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
	data, err := e.s3.ReadSmall(context.Background(), "projects/"+c.ID+"/sealed/f/hid.ybin.gz", 100)
	if err != nil || string(data) != "hidden text" {
		t.Fatalf("sealed text: %q, %v", data, err)
	}

	// The two manifests become one, whole.
	manifest := e.manifest(c.ID, "sealed/manifest.json.gz")
	if len(manifest) != 3 || manifest[0].Path != "img.png" || manifest[1].Path != "old.test.py" || manifest[2].Path != "t.test.py" {
		t.Fatalf("manifest: %+v", manifest)
	}
	if manifest[0].Hash != strings.Repeat("c", 64) || manifest[0].Mime != "image/png" || manifest[2].ID != "hid" || manifest[2].Size != 11 {
		t.Fatalf("manifest lost fields: %+v", manifest)
	}

	// Its new owner reads sealed/ but cannot write there nor make it public.
	token := e.saverOf(c)
	if status, urls, _ := e.presign(bob, c.ID, "", get("sealed/f/hid.ybin.gz")); status != http.StatusOK || urls["sealed/f/hid.ybin.gz"] == "" {
		t.Errorf("owner of the copy reads the sealed test: %d", status)
	}
	if status, _, _ := e.presign(bob, c.ID, token, put("sealed/f/hid.ybin.gz", 3)); status != http.StatusForbidden {
		t.Errorf("owner of the copy writes the sealed test: %d", status)
	}
	if status, _, _ := e.presign(bob, c.ID, token, put("sealed/manifest.json.gz", 3)); status != http.StatusForbidden {
		t.Errorf("owner of the copy rewrites the manifest: %d", status)
	}
}

func TestCopyOfACopyStaysSealed(t *testing.T) {
	e := setup(t)
	alice, bob, carol := newUser(), newUser(), newUser()
	p := e.create(alice, "source")
	fill(e, p)
	e.setPublic(alice, p.ID, true)
	c := e.copyOf(bob, p.ID)
	e.setPublic(bob, c.ID, true)
	d := e.copyOf(carol, c.ID)
	keys := e.keys(d.ID)
	if !has(keys, "sealed/f/hid.ybin.gz") || !has(keys, "sealed/f/sea.ybin.gz") {
		t.Fatalf("sealed files lost: %v", keys)
	}
	if got := e.manifest(d.ID, "sealed/manifest.json.gz"); len(got) != 3 {
		t.Fatalf("manifest: %+v", got)
	}
	// A stranger never reads a public copy's sealed files.
	if status, _, _ := e.presign(carol, c.ID, "", get("sealed/f/hid.ybin.gz")); status != http.StatusNotFound {
		t.Errorf("stranger on a public copy's sealed: got %d", status)
	}
}

func TestCopyWithoutManifests(t *testing.T) {
	e := setup(t)
	alice, bob := newUser(), newUser()
	p := e.create(alice, "plain")
	e.raw(p, "public/f/a.ybin.gz", []byte("x"))
	e.setPublic(alice, p.ID, true)
	c := e.copyOf(bob, p.ID)
	if !has(e.keys(c.ID), "public/f/a.ybin.gz") {
		t.Fatalf("copy: %v", e.keys(c.ID))
	}
}

func TestCopyManifestOverLimitRefused(t *testing.T) {
	e := setup(t)
	alice, bob := newUser(), newUser()
	p := e.create(alice, "big manifest")
	// Incompressible-enough filler past 1 MB: the one file the server reads is bounded.
	big := make([]byte, 0, 1<<21)
	for len(big) < 1<<21 {
		big = fmt.Appendf(big, "%x", uuid.New())
	}
	e.raw(p, "hidden/manifest.json.gz", big)
	e.setPublic(alice, p.ID, true)
	if status, _ := e.do(bob, "POST", "/api/projects/"+p.ID+"/copy", map[string]any{}); status < 400 {
		t.Fatalf("manifest over 1 MB: got %d", status)
	}
}

func TestCopyNamesDoNotCollide(t *testing.T) {
	e := setup(t)
	alice, bob := newUser(), newUser()
	p := e.create(alice, "source")
	e.setPublic(alice, p.ID, true)
	a, b := e.copyOf(bob, p.ID), e.copyOf(bob, p.ID)
	if a.Name == b.Name {
		t.Fatalf("two copies named %q: names are unique per owner", a.Name)
	}
	own := e.copyOf(alice, p.ID)
	if own.Name == p.Name {
		t.Fatalf("a copy of one's own project took its name: %q", own.Name)
	}
}

func TestCopyOfPrivateForeign404(t *testing.T) {
	e := setup(t)
	alice, bob := newUser(), newUser()
	p := e.create(alice, "private")
	fill(e, p)
	if status, _ := e.do(bob, "POST", "/api/projects/"+p.ID+"/copy", map[string]any{}); status != http.StatusNotFound {
		t.Fatalf("got %d, want 404", status)
	}
	status, data := e.do(bob, "GET", "/api/projects", nil)
	if status != http.StatusOK || strings.Contains(string(data), `"id"`) {
		t.Fatalf("a refused copy left a project: %d %s", status, data)
	}
	// One's own private project can be copied.
	c := e.copyOf(alice, p.ID)
	if !has(e.keys(c.ID), "public/f/pub.ybin.gz") {
		t.Fatalf("own copy: %v", e.keys(c.ID))
	}
}
