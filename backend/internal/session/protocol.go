// Package session implements live-share sessions over WebRTC.
//
// The project lives in the owner's browser; members exchange Yjs updates,
// cursors and runner signals peer to peer. This server only:
//   - authenticates members (cookie id) and tells everyone each member's role,
//   - forwards WebRTC signaling (offers, answers, ICE candidates),
//   - relays binary data for pairs that cannot connect directly.
//
// It stores no document content. Each role has its own join code; the
// member's role (and level) comes from the code they joined with.
package session

// Text frames are JSON control messages; binary frames are relayed data:
// client -> server [to u32 big endian][payload], server -> client [from u32][payload].

// Built-in roles; any other role name is a custom one (with level read or write).
const (
	RoleOwner = "owner"
	RoleAdmin = "admin"
	RoleWrite = "write"
	RoleRead  = "read"
)

const (
	LevelRead  = "read"
	LevelWrite = "write"
	LevelAdmin = "admin"
)

// peerInfo describes one connected member to the others.
type peerInfo struct {
	Peer   uint32   `json:"peer"`
	UserID string   `json:"userId"`
	Level  string   `json:"level"`
	Roles  []string `json:"roles"` // custom roles (each opens its folders)
	Owner  bool     `json:"owner,omitempty"`
}

// control is every JSON message in either direction.
type control struct {
	Type    string     `json:"type"`              // welcome | join | leave | signal | owner | role | setRole | reset | error | ended
	You     *peerInfo  `json:"you,omitempty"`     // welcome
	Session *Session   `json:"session,omitempty"` // welcome
	Peers   []peerInfo `json:"peers,omitempty"`   // welcome
	Peer    *peerInfo  `json:"peer,omitempty"`    // join / leave / role
	To      uint32     `json:"to,omitempty"`      // signal (client -> server)
	From    uint32     `json:"from,omitempty"`    // signal (server -> client)
	Data    jsonRaw    `json:"data,omitempty"`    // signal payload (SDP / ICE), opaque
	Error   string     `json:"error,omitempty"`   // error
	Owner   *uint32    `json:"owner,omitempty"`   // welcome / owner: who acts as the owner (0: nobody)
	Level   string     `json:"level,omitempty"`   // setRole (client -> server, with To): the new level
	Roles   []string   `json:"roles,omitempty"`   // setRole: the new custom roles
}
