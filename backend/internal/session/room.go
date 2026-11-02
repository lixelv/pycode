package session

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"sync"

	"github.com/coder/websocket"
	"github.com/google/uuid"
)

// member is one WebSocket connection to a room.
type member struct {
	info peerInfo
	user uuid.UUID
	code string // the code this member joined with
	conn *websocket.Conn
	send chan outFrame
}

type outFrame struct {
	binary bool
	data   []byte
}

// room holds the live members of one session.
type room struct {
	session *Session

	mu       sync.Mutex
	members  map[uint32]*member
	nextPeer uint32
	// owner is who acts as the owner: the real one while connected, else
	// the admin who joined first, else 0.
	owner uint32
	// saver is the owner's tab that writes the project to S3, with the token
	// that says so when it asks for URLs (only in a project's room).
	saver      uint32
	saverToken string
}

// pickSaver is the owner's earliest connection: never a guest, not even an admin.
func (r *room) pickSaver() uint32 {
	var best uint32
	for id, m := range r.members {
		if m.user == r.session.OwnerID && (best == 0 || id < best) {
			best = id
		}
	}
	return best
}

// updateSaver names the saver when that changes; a newcomer hears either way.
// Call with r.mu held.
func (r *room) updateSaver(newcomer *member) {
	if r.session.ProjectID == nil {
		return
	}
	next := r.pickSaver()
	if next == r.saver {
		if newcomer != nil {
			newcomer.enqueueJSON(control{Type: "saver", Saver: &next})
		}
		return
	}
	r.saver, r.saverToken = next, ""
	if next != 0 {
		r.saverToken = newSaverToken()
	}
	for id, m := range r.members {
		msg := control{Type: "saver", Saver: &next}
		if id == next {
			msg.Token = r.saverToken
		}
		m.enqueueJSON(msg)
	}
}

func newSaverToken() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// isSaver checks a token against the current saver's.
func (r *room) isSaver(token string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return token != "" && r.saver != 0 && subtle.ConstantTimeCompare([]byte(token), []byte(r.saverToken)) == 1
}

// pickOwner chooses the acting owner. Call with r.mu held.
func (r *room) pickOwner() uint32 {
	var best, bestAdmin uint32
	for id, m := range r.members {
		if m.user == r.session.OwnerID && (best == 0 || id < best) {
			best = id
		}
		if m.info.Level == LevelAdmin && (bestAdmin == 0 || id < bestAdmin) {
			bestAdmin = id
		}
	}
	if best != 0 {
		return best
	}
	return bestAdmin
}

// updateOwner tells everyone when the acting owner changes. Call with r.mu held.
func (r *room) updateOwner() {
	next := r.pickOwner()
	if next == r.owner {
		return
	}
	r.owner = next
	for _, m := range r.members {
		m.enqueueJSON(control{Type: "owner", Owner: &next})
	}
}

func (r *room) join(m *member) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.nextPeer++
	m.info.Peer = r.nextPeer
	peers := make([]peerInfo, 0, len(r.members))
	for _, other := range r.members {
		peers = append(peers, other.info)
		other.enqueueJSON(control{Type: "join", Peer: &m.info})
	}
	r.members[m.info.Peer] = m
	owner := r.pickOwner()
	r.owner = owner
	// Each member gets the session with their own code (codes differ by role).
	own := *r.session
	own.Code = m.code
	m.enqueueJSON(control{Type: "welcome", You: &m.info, Session: &own, Peers: peers, Owner: &owner})
	for _, other := range r.members {
		if other != m {
			other.enqueueJSON(control{Type: "owner", Owner: &owner})
		}
	}
	r.updateSaver(m)
}

func (r *room) leave(m *member) (empty bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.members[m.info.Peer] != m {
		return len(r.members) == 0
	}
	delete(r.members, m.info.Peer)
	for _, other := range r.members {
		other.enqueueJSON(control{Type: "leave", Peer: &m.info})
	}
	r.updateOwner()
	r.updateSaver(nil)
	return len(r.members) == 0
}

// signal forwards WebRTC signaling to one member, stamped with the sender.
func (r *room) signal(from *member, msg control) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if to := r.members[msg.To]; to != nil && to != from {
		to.enqueueJSON(control{Type: "signal", From: from.info.Peer, Data: msg.Data})
	}
}

// reset tells everyone the owner reset the project. Only the acting owner may.
func (r *room) reset(from *member) {
	r.mu.Lock()
	defer r.mu.Unlock()
	// Any tab of the owner: a project may be open in several.
	if from.info.Peer != r.owner && from.user != r.session.OwnerID {
		from.enqueueJSON(control{Type: "error", Error: "Only the owner can reset the session's project."})
		return
	}
	for _, m := range r.members {
		if m != from {
			m.enqueueJSON(control{Type: "reset", From: from.info.Peer})
		}
	}
}

// relay forwards binary data for pairs without a direct connection.
func (r *room) relay(from *member, frame []byte) {
	if len(frame) < 4 {
		return
	}
	to := binary.BigEndian.Uint32(frame[:4])
	out := make([]byte, len(frame))
	binary.BigEndian.PutUint32(out[:4], from.info.Peer)
	copy(out[4:], frame[4:])
	r.mu.Lock()
	defer r.mu.Unlock()
	if m := r.members[to]; m != nil && m != from {
		m.enqueue(outFrame{binary: true, data: out})
	}
}

// canSetRole: an admin may change the role of members below admin (but not
// make admins); the owner may change anyone's but their own, admins too.
func canSetRole(fromLevel string, fromOwner bool, targetLevel string, targetIsOwner bool, nextLevel string) bool {
	if targetIsOwner || fromLevel != LevelAdmin {
		return false
	}
	if fromOwner {
		return true
	}
	return targetLevel != LevelAdmin && nextLevel != LevelAdmin
}

// member returns the member with this peer number (nil if gone).
func (r *room) member(peer uint32) *member {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.members[peer]
}

// setRole gives a member a new level and roles and tells everyone.
func (r *room) setRole(peer uint32, g grant) {
	r.mu.Lock()
	defer r.mu.Unlock()
	m := r.members[peer]
	if m == nil {
		return
	}
	m.info.Level, m.info.Roles = g.Level, g.Roles
	info := m.info
	for _, other := range r.members {
		other.enqueueJSON(control{Type: "role", Peer: &info})
	}
	r.updateOwner() // an admin less (or more) may change who stands in for the owner
}

// remove disconnects every connection of a user (kicked or banned), telling
// them why and everyone else that they left.
func (r *room) remove(user uuid.UUID, ban bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for id, m := range r.members {
		if m.user != user {
			continue
		}
		m.enqueueJSON(control{Type: "removed", Ban: ban})
		close(m.send) // the writer then closes the connection
		delete(r.members, id)
		for _, other := range r.members {
			other.enqueueJSON(control{Type: "leave", Peer: &m.info})
		}
	}
	r.updateOwner()
	r.updateSaver(nil)
}

// removeGuests sends away everyone but the owner: the session's codes are gone,
// the owner's own room goes on.
func (r *room) removeGuests() {
	r.mu.Lock()
	guests := map[uuid.UUID]bool{}
	for _, m := range r.members {
		if m.user != r.session.OwnerID {
			guests[m.user] = true
		}
	}
	r.mu.Unlock()
	for user := range guests {
		r.remove(user, false)
	}
}

// hasAdmin reports whether this user is connected with admin rights.
func (r *room) hasAdmin(user uuid.UUID) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, m := range r.members {
		if m.user == user && m.info.Level == LevelAdmin {
			return true
		}
	}
	return false
}

func (r *room) end() {
	r.mu.Lock()
	defer r.mu.Unlock()
	for id, m := range r.members {
		m.enqueueJSON(control{Type: "ended"})
		close(m.send)
		delete(r.members, id)
	}
	r.saver, r.saverToken = 0, ""
}

func (m *member) enqueueJSON(msg control) {
	data, _ := json.Marshal(msg)
	m.enqueue(outFrame{data: data})
}

func (m *member) enqueue(f outFrame) {
	defer func() { _ = recover() }() // send on a closed channel after end()
	select {
	case m.send <- f:
	default:
		// Too slow to keep up: drop the connection; the client reconnects.
		if m.conn != nil {
			_ = m.conn.Close(websocket.StatusPolicyViolation, "too slow")
		}
	}
}
