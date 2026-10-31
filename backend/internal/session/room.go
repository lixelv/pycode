package session

import (
	"encoding/binary"
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
	if from.info.Peer != r.owner {
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
