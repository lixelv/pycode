package session

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lixelv/polycode/backend/internal/db"
	"github.com/lixelv/polycode/backend/internal/identity"
)

// Integration tests against a real Postgres (TEST_DATABASE_URL), skipped without it.
type projectEnv struct {
	t    *testing.T
	pool *pgxpool.Pool
	hub  *Hub
	srv  *httptest.Server
}

func setupProjects(t *testing.T) *projectEnv {
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
	hub := NewHub(pool, nil)
	mux := http.NewServeMux()
	hub.Register(mux)
	srv := httptest.NewServer(identity.NewMiddleware(pool).Wrap(mux))
	t.Cleanup(srv.Close)
	return &projectEnv{t: t, pool: pool, hub: hub, srv: srv}
}

func (e *projectEnv) newProject(owner uuid.UUID) uuid.UUID {
	e.t.Helper()
	ctx := context.Background()
	if _, err := e.pool.Exec(ctx, `INSERT INTO users (id) VALUES ($1) ON CONFLICT DO NOTHING`, owner); err != nil {
		e.t.Fatal(err)
	}
	id := uuid.Must(uuid.NewV7())
	if _, err := e.pool.Exec(ctx, `INSERT INTO projects (id, owner_id, name) VALUES ($1, $2, $3)`, id, owner, "p-"+id.String()); err != nil {
		e.t.Fatal(err)
	}
	return id
}

func (e *projectEnv) post(user uuid.UUID, path string) (int, string) {
	e.t.Helper()
	req, _ := http.NewRequest("POST", e.srv.URL+path, nil)
	req.AddCookie(&http.Cookie{Name: "pc_uid", Value: user.String()})
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(data)
}

func (e *projectEnv) getStatus(path string) int {
	e.t.Helper()
	resp, err := http.Get(e.srv.URL + path)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	return resp.StatusCode
}

func TestSessionForProjectIsOnePerProject(t *testing.T) {
	e := setupProjects(t)
	ctx := context.Background()
	owner := uuid.Must(uuid.NewV7())
	project := e.newProject(owner)
	a, err := e.hub.SessionForProject(ctx, project)
	if err != nil {
		t.Fatal(err)
	}
	b, err := e.hub.SessionForProject(ctx, project)
	if err != nil {
		t.Fatal(err)
	}
	if a.ID != b.ID {
		t.Fatalf("two sessions for one project: %s, %s", a.ID, b.ID)
	}
	if a.OwnerID != owner || a.ProjectID == nil || *a.ProjectID != project {
		t.Fatalf("session: %+v", a)
	}
	raw, err := json.Marshal(a)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"projectId":"`+project.String()+`"`) {
		t.Fatalf("session JSON has no projectId: %s", raw)
	}
	other, err := e.hub.SessionForProject(ctx, e.newProject(owner))
	if err != nil {
		t.Fatal(err)
	}
	if other.ID == a.ID {
		t.Fatal("two projects share a session")
	}
}

func TestEndingAProjectSessionKeepsTheOwnersRoom(t *testing.T) {
	e := setupProjects(t)
	ctx := context.Background()
	ownerID := uuid.Must(uuid.NewV7())
	project := e.newProject(ownerID)
	sess, err := e.hub.SessionForProject(ctx, project)
	if err != nil {
		t.Fatal(err)
	}
	r := &room{session: sess, members: map[uint32]*member{}}
	e.hub.rooms[sess.ID] = r
	tab := newMember(ownerID, RoleOwner, LevelAdmin)
	r.join(tab)
	guest := newMember(uuid.New(), "write", LevelWrite)
	r.join(guest)
	_, saver := drain(tab)
	drain(guest)

	if status, body := e.post(guest.user, "/api/sessions/"+sess.Code+"/end"); status != http.StatusForbidden {
		t.Fatalf("a guest ended the session: %d %s", status, body)
	}
	if status, body := e.post(ownerID, "/api/sessions/"+sess.Code+"/end"); status >= 300 {
		t.Fatalf("end: %d %s", status, body)
	}
	if raw, _ := drain(guest); !strings.Contains(raw, `"removed"`) {
		t.Fatalf("the guest should get removed: %s", raw)
	}
	if raw, _ := drain(tab); strings.Contains(raw, `"ended"`) || strings.Contains(raw, `"removed"`) {
		t.Fatalf("the owner's tab should stay: %s", raw)
	}
	if e.hub.rooms[sess.ID] != r {
		t.Fatal("the room should go on")
	}
	if !e.hub.IsSaver(project, saver.Token) {
		t.Fatal("the saver should not change")
	}
	// The codes are revoked.
	if status := e.getStatus("/api/sessions/" + sess.Code); status == http.StatusOK {
		t.Fatal("the old code still opens the session")
	}
	// The next Share issues new ones, in the same room.
	next, err := e.hub.SessionForProject(ctx, project)
	if err != nil {
		t.Fatal(err)
	}
	if next.Code == sess.Code {
		t.Fatal("the next Share gave the revoked code")
	}
	if status := e.getStatus("/api/sessions/" + next.Code); status != http.StatusOK {
		t.Fatalf("the new code: %d", status)
	}
}

func TestExpireOnlySessionsWithoutProject(t *testing.T) {
	e := setupProjects(t)
	ctx := context.Background()
	owner := uuid.Must(uuid.NewV7())
	withProject, err := e.hub.SessionForProject(ctx, e.newProject(owner))
	if err != nil {
		t.Fatal(err)
	}
	free, _, err := e.hub.store.Create(ctx, owner, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-48 * time.Hour)
	if _, err := e.pool.Exec(ctx, `UPDATE sessions SET last_active = $1 WHERE id = ANY($2)`, old, []uuid.UUID{withProject.ID, free.ID}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.hub.store.Expire(ctx, 24*time.Hour); err != nil {
		t.Fatal(err)
	}
	count := func(id uuid.UUID) int {
		var n int
		if err := e.pool.QueryRow(ctx, `SELECT count(*) FROM sessions WHERE id = $1`, id).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	if count(free.ID) != 0 {
		t.Error("a session without a project should expire after 24 h")
	}
	if count(withProject.ID) != 1 {
		t.Error("a project's session does not expire")
	}
}

func TestDeletingAProjectRowTakesItsSession(t *testing.T) {
	e := setupProjects(t)
	ctx := context.Background()
	owner := uuid.Must(uuid.NewV7())
	project := e.newProject(owner)
	sess, err := e.hub.SessionForProject(ctx, project)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.pool.Exec(ctx, `DELETE FROM projects WHERE id = $1`, project); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := e.pool.QueryRow(ctx, `SELECT count(*) FROM sessions WHERE id = $1`, sess.ID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatal("the session outlived its project")
	}
}
