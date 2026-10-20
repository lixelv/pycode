// Package session implements live-share sessions over WebRTC.
//
// The project lives in the owner's browser; members exchange Yjs updates,
// cursors and runner signals peer to peer. This server only:
//   - authenticates members (cookie id) and tells everyone each member's role,
//   - forwards WebRTC signaling (offers, answers, ICE candidates),
//   - relays binary data for pairs that cannot connect directly.
//
// It stores no document content.
package session

// Text frames are JSON control messages; binary frames are relayed data:
// client -> server [to u32 big endian][payload], server -> client [from u32][payload].

const (
	RoleOwner  = "owner"
	RoleEditor = "editor"
	RoleViewer = "viewer"
)

const (
	ModeReadOnly  = "read_only"
	ModeReadWrite = "read_write"
)

// peerInfo describes one connected member to the others.
type peerInfo struct {
	Peer   uint32 `json:"peer"`
	UserID string `json:"userId"`
	Role   string `json:"role"`
}

// control is every JSON message in either direction.
type control struct {
	Type    string     `json:"type"`              // welcome | join | leave | signal | ended
	You     *peerInfo  `json:"you,omitempty"`     // welcome
	Session *Session   `json:"session,omitempty"` // welcome
	Peers   []peerInfo `json:"peers,omitempty"`   // welcome
	Peer    *peerInfo  `json:"peer,omitempty"`    // join / leave
	To      uint32     `json:"to,omitempty"`      // signal (client -> server)
	From    uint32     `json:"from,omitempty"`    // signal (server -> client)
	Data    jsonRaw    `json:"data,omitempty"`    // signal payload (SDP / ICE), opaque
	Error   string     `json:"error,omitempty"`   // error
}
