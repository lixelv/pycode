package session

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// A control frame as the client reads it, whatever the server's struct looks like.
type saverFrame struct {
	Type  string  `json:"type"`
	Saver *uint32 `json:"saver"`
	Token string  `json:"token"`
}

// drain takes everything a member got: the raw frames and the last saver message.
func drain(m *member) (raw string, latest *saverFrame) {
	var all strings.Builder
	for {
		select {
		case f, ok := <-m.send:
			if !ok {
				return all.String(), latest
			}
			all.Write(f.data)
			all.WriteByte('\n')
			var c saverFrame
			if json.Unmarshal(f.data, &c) == nil && c.Type == "saver" {
				latest = &c
			}
		default:
			return all.String(), latest
		}
	}
}

// projectHub is a hub with one project's room, no database needed.
func projectHub(ownerID uuid.UUID) (*Hub, *room, uuid.UUID) {
	project := uuid.Must(uuid.NewV7())
	r := &room{session: &Session{ID: uuid.New(), OwnerID: ownerID, ProjectID: &project}, members: map[uint32]*member{}}
	h := &Hub{rooms: map[uuid.UUID]*room{r.session.ID: r}}
	return h, r, project
}

func TestSaverIsEarliestOwnerConn(t *testing.T) {
	ownerID := uuid.Must(uuid.NewV7())
	h, r, project := projectHub(ownerID)
	// A guest admin came first; the earliest connection OF THE OWNER is the saver.
	guest := newMember(uuid.New(), "admin", LevelAdmin)
	r.join(guest)
	first := newMember(ownerID, RoleOwner, LevelAdmin)
	r.join(first)
	second := newMember(ownerID, RoleOwner, LevelAdmin)
	r.join(second)

	firstRaw, msg := drain(first)
	if msg == nil || msg.Saver == nil || *msg.Saver != first.info.Peer {
		t.Fatalf("saver message to the first connection: %+v (%s)", msg, firstRaw)
	}
	if msg.Token == "" {
		t.Fatal("the saver has no token")
	}
	if !h.IsSaver(project, msg.Token) {
		t.Fatal("the hub does not recognise the saver's token")
	}
	// The token goes to its addressee alone.
	for _, other := range []*member{guest, second} {
		raw, _ := drain(other)
		if strings.Contains(raw, msg.Token) {
			t.Fatalf("someone else got the token: %s", raw)
		}
	}
}

func TestEveryoneInTheRoomLearnsTheSaver(t *testing.T) {
	ownerID := uuid.Must(uuid.NewV7())
	_, r, _ := projectHub(ownerID)
	first := newMember(ownerID, RoleOwner, LevelAdmin)
	r.join(first)
	second := newMember(ownerID, RoleOwner, LevelAdmin)
	r.join(second)
	drain(first)
	_, seen := drain(second)
	if seen == nil || seen.Saver == nil || *seen.Saver != first.info.Peer || seen.Token != "" {
		t.Fatalf("a newcomer should hear who saves, without the token: %+v", seen)
	}
}

func TestSaverMovesOnLeave(t *testing.T) {
	ownerID := uuid.Must(uuid.NewV7())
	h, r, project := projectHub(ownerID)
	first := newMember(ownerID, RoleOwner, LevelAdmin)
	r.join(first)
	second := newMember(ownerID, RoleOwner, LevelAdmin)
	r.join(second)
	third := newMember(ownerID, RoleOwner, LevelAdmin)
	r.join(third)
	_, was := drain(first)
	drain(second)
	drain(third)

	r.leave(first)
	_, now := drain(second)
	if now == nil || now.Saver == nil || *now.Saver != second.info.Peer || now.Token == "" {
		t.Fatalf("the next connection in order should save: %+v", now)
	}
	if now.Token == was.Token {
		t.Fatal("a new saver needs a new token")
	}
	if h.IsSaver(project, was.Token) || !h.IsSaver(project, now.Token) {
		t.Fatal("only the current saver's token counts")
	}
	raw, other := drain(third)
	if other == nil || other.Saver == nil || *other.Saver != second.info.Peer {
		t.Fatalf("the others should hear of the move: %+v", other)
	}
	if strings.Contains(raw, now.Token) {
		t.Fatal("the token leaked to another tab")
	}
}

func TestOldSaverTokenRejected(t *testing.T) {
	ownerID := uuid.Must(uuid.NewV7())
	h, r, project := projectHub(ownerID)
	tab := newMember(ownerID, RoleOwner, LevelAdmin)
	r.join(tab)
	_, was := drain(tab)
	r.leave(tab)
	if h.IsSaver(project, was.Token) {
		t.Fatal("no owner connected: nobody is the saver")
	}
	back := newMember(ownerID, RoleOwner, LevelAdmin)
	r.join(back)
	_, now := drain(back)
	if now == nil || now.Token == "" || now.Token == was.Token {
		t.Fatalf("a returning owner gets a new token: %+v", now)
	}
	if h.IsSaver(project, was.Token) {
		t.Fatal("the old token still works")
	}
	if !h.IsSaver(project, now.Token) {
		t.Fatal("the new token does not work")
	}
}

func TestGuestAdminNeverSaver(t *testing.T) {
	ownerID := uuid.Must(uuid.NewV7())
	h, r, project := projectHub(ownerID)
	a := newMember(uuid.New(), "admin", LevelAdmin)
	r.join(a)
	b := newMember(uuid.New(), "write", LevelWrite)
	r.join(b)
	for _, m := range []*member{a, b} {
		if _, msg := drain(m); msg != nil && (msg.Token != "" || (msg.Saver != nil && *msg.Saver != 0)) {
			t.Fatalf("a guest got named: %+v", msg)
		}
	}
	if h.IsSaver(project, "") {
		t.Fatal("an empty token passed")
	}
	// The owner leaves: an acting owner takes over the room, not the saving.
	tab := newMember(ownerID, RoleOwner, LevelAdmin)
	r.join(tab)
	_, was := drain(tab)
	drain(a)
	r.leave(tab)
	if r.owner != a.info.Peer {
		t.Fatalf("acting owner: %d", r.owner)
	}
	if raw, msg := drain(a); strings.Contains(raw, was.Token) || (msg != nil && msg.Token != "") {
		t.Fatalf("the acting owner got a token: %s", raw)
	}
	if h.IsSaver(project, was.Token) {
		t.Fatal("nobody saves until the owner returns")
	}
}

func TestIsSaverOfAnotherProjectFails(t *testing.T) {
	ownerID := uuid.Must(uuid.NewV7())
	h, r, _ := projectHub(ownerID)
	tab := newMember(ownerID, RoleOwner, LevelAdmin)
	r.join(tab)
	_, msg := drain(tab)
	if h.IsSaver(uuid.Must(uuid.NewV7()), msg.Token) {
		t.Fatal("a token opened another project")
	}
}

func TestSessionWithoutProjectHasNoSaver(t *testing.T) {
	ownerID := uuid.Must(uuid.NewV7())
	r := newRoom(ownerID)
	tab := newMember(ownerID, RoleOwner, LevelAdmin)
	r.join(tab)
	if _, msg := drain(tab); msg != nil {
		t.Fatalf("a session without a project saves nothing: %+v", msg)
	}
}

func TestCloseProjectEndsTheRoom(t *testing.T) {
	ownerID := uuid.Must(uuid.NewV7())
	h, r, project := projectHub(ownerID)
	tab := newMember(ownerID, RoleOwner, LevelAdmin)
	r.join(tab)
	guest := newMember(uuid.New(), "write", LevelWrite)
	r.join(guest)
	_, msg := drain(tab)
	drain(guest)

	h.CloseProject(project)
	if raw, _ := drain(guest); !strings.Contains(raw, `"ended"`) {
		t.Fatalf("a guest should be told: %q", raw)
	}
	if raw, _ := drain(tab); !strings.Contains(raw, `"ended"`) {
		t.Fatalf("the owner's tab should be told: %q", raw)
	}
	if h.IsSaver(project, msg.Token) {
		t.Fatal("a closed room has no saver")
	}
	if _, there := h.rooms[r.session.ID]; there {
		t.Fatal("the room is still in the hub")
	}
	h.CloseProject(uuid.Must(uuid.NewV7())) // no such room: nothing happens
}

// The per-session MCP route is gone; the session's other routes stay.
func TestOldEndpointGone(t *testing.T) {
	mux := http.NewServeMux()
	NewHub(nil, nil).Register(mux)
	srv := httptest.NewServer(mux)
	defer srv.Close()
	resp, err := http.Post(srv.URL+"/s/ABCDEF/mcp", "application/json", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"ping"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("got %d, want 404", resp.StatusCode)
	}
}

func TestAnyTabOfTheOwnerResets(t *testing.T) {
	ownerID := uuid.Must(uuid.NewV7())
	_, r, _ := projectHub(ownerID)
	first := newMember(ownerID, RoleOwner, LevelAdmin)
	r.join(first)
	second := newMember(ownerID, RoleOwner, LevelAdmin)
	r.join(second)
	r.reset(second)
	if last(second, "error") != nil || last(first, "reset") == nil {
		t.Fatal("a second tab of the owner should reset")
	}
}
