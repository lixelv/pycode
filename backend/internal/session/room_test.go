package session

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/lixelv/python-coder/backend/internal/identity"
)

func newMember(user uuid.UUID, role, level string) *member {
	info := peerInfo{UserID: user.String(), Level: level, Roles: []string{}, Owner: role == RoleOwner}
	if validRole(role) {
		info.Roles = []string{role}
	}
	return &member{info: info, user: user, send: make(chan outFrame, 64)}
}

func newRoom(owner uuid.UUID) *room {
	return &room{session: &Session{OwnerID: owner}, members: map[uint32]*member{}}
}

// last returns the last control message of a type a member received.
func last(m *member, typ string) *control {
	var found *control
	for {
		select {
		case f := <-m.send:
			var c control
			if json.Unmarshal(f.data, &c) == nil && c.Type == typ {
				found = &c
			}
		default:
			return found
		}
	}
}

func TestOwnerFailover(t *testing.T) {
	ownerID := uuid.New()
	r := newRoom(ownerID)
	owner := newMember(ownerID, RoleOwner, LevelAdmin)
	r.join(owner) // peer 1
	student := newMember(uuid.New(), "write", LevelWrite)
	r.join(student) // peer 2
	a3 := newMember(uuid.New(), "admin", LevelAdmin)
	r.join(a3) // peer 3
	a4 := newMember(uuid.New(), "admin", LevelAdmin)
	r.join(a4) // peer 4
	if r.owner != 1 {
		t.Fatalf("owner online: got %d, want 1", r.owner)
	}
	last(student, "owner")

	r.leave(owner)
	if r.owner != 3 {
		t.Fatalf("owner gone: got %d, want the earliest admin 3", r.owner)
	}
	if c := last(student, "owner"); c == nil || c.Owner == nil || *c.Owner != 3 {
		t.Fatalf("student not told about the new owner: %+v", c)
	}

	back := newMember(ownerID, RoleOwner, LevelAdmin)
	r.join(back) // peer 5
	if r.owner != 5 {
		t.Fatalf("owner back: got %d, want 5", r.owner)
	}
	if c := last(back, "welcome"); c == nil || c.Owner == nil || *c.Owner != 5 {
		t.Fatalf("welcome should name the owner: %+v", c)
	}

	r.leave(back)
	r.leave(a3)
	r.leave(a4)
	if r.owner != 0 {
		t.Fatalf("no admin left: got %d, want 0", r.owner)
	}
}

func TestResetOnlyFromOwner(t *testing.T) {
	ownerID := uuid.New()
	r := newRoom(ownerID)
	owner := newMember(ownerID, RoleOwner, LevelAdmin)
	r.join(owner)
	admin := newMember(uuid.New(), "admin", LevelAdmin)
	r.join(admin)

	r.reset(admin)
	if last(admin, "error") == nil {
		t.Fatal("an admin who is not the owner must get an error")
	}
	if last(owner, "reset") != nil {
		t.Fatal("a refused reset must not reach anyone")
	}

	r.leave(owner) // the admin now stands in for the owner
	r.reset(admin)
	if last(admin, "error") != nil {
		t.Fatal("the acting owner may reset")
	}
}

func TestValidRole(t *testing.T) {
	for name, ok := range map[string]bool{"ivan": true, "group_2": true, "admin": false, "owner": false, "": false, "a b": false} {
		if validRole(name) != ok {
			t.Errorf("validRole(%q) = %v", name, !ok)
		}
	}
}

func TestWelcomeCarriesOwnCode(t *testing.T) {
	ownerID := uuid.New()
	r := newRoom(ownerID)
	r.session.Code = "WRITECODE"
	owner := newMember(ownerID, RoleOwner, LevelAdmin)
	owner.code = "WRITECODE"
	r.join(owner)
	student := newMember(uuid.New(), RoleRead, LevelRead)
	student.code = "READCODE"
	r.join(student)
	if c := last(student, "welcome"); c == nil || c.Session == nil || c.Session.Code != "READCODE" {
		t.Fatalf("a member must be welcomed with the code they joined with, got %+v", c.Session)
	}
	if r.session.Code != "WRITECODE" {
		t.Fatal("the room's session must not change")
	}
}

func TestUserIDsStayOnTheServer(t *testing.T) {
	owner := uuid.Must(uuid.NewV7())
	data, err := json.Marshal(&Session{ID: uuid.New(), OwnerID: owner, Code: "X"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), owner.String()) {
		t.Fatalf("the owner's cookie id leaks into the session JSON: %s", data)
	}
	if !strings.Contains(string(data), identity.Public(owner)) {
		t.Fatalf("the session should name its owner by public id: %s", data)
	}
	if identity.Public(owner) == owner.String() || identity.Public(owner) != identity.Public(owner) {
		t.Fatal("a public id must be stable and differ from the cookie id")
	}
}

func TestCanSetRole(t *testing.T) {
	cases := []struct {
		name                     string
		from, target, next       string
		fromOwner, targetIsOwner bool
		want                     bool
	}{
		{"admin demotes a writer", LevelAdmin, LevelWrite, LevelRead, false, false, true},
		{"admin promotes a reader to write", LevelAdmin, LevelRead, LevelWrite, false, false, true},
		{"admin cannot make an admin", LevelAdmin, LevelWrite, LevelAdmin, false, false, false},
		{"admin cannot touch an admin", LevelAdmin, LevelAdmin, LevelRead, false, false, false},
		{"owner makes an admin", LevelAdmin, LevelWrite, LevelAdmin, true, false, true},
		{"owner demotes an admin", LevelAdmin, LevelAdmin, LevelWrite, true, false, true},
		{"nobody changes the owner", LevelAdmin, LevelAdmin, LevelRead, true, true, false},
		{"a writer changes nobody", LevelWrite, LevelRead, LevelWrite, false, false, false},
	}
	for _, c := range cases {
		if got := canSetRole(c.from, c.fromOwner, c.target, c.targetIsOwner, c.next); got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}

func TestSetRoleTellsEveryone(t *testing.T) {
	ownerID := uuid.New()
	r := newRoom(ownerID)
	owner := newMember(ownerID, RoleOwner, LevelAdmin)
	r.join(owner)
	student := newMember(uuid.New(), RoleWrite, LevelWrite)
	r.join(student)
	last(owner, "role")
	r.setRole(student.info.Peer, grant{Level: LevelWrite, Roles: []string{"ivan", "olga"}})
	if c := last(owner, "role"); c == nil || c.Peer == nil || c.Peer.Peer != student.info.Peer || len(c.Peer.Roles) != 2 {
		t.Fatalf("everyone must hear about the new roles: %+v", c)
	}
	if c := last(student, "role"); c == nil || c.Peer.Roles[1] != "olga" {
		t.Fatalf("the member must hear about their own new roles: %+v", c)
	}
	if len(student.info.Roles) != 2 {
		t.Fatal("the room must keep the new roles")
	}
}
