// Package projects keeps users' projects: rows in Postgres, contents in S3,
// reached by browsers through presigned URLs given out here.
package projects

import (
	"regexp"
	"strings"
	"time"
)

const (
	PresignTTL = 5 * time.Minute
	// SweepDelay outlives every URL given out before a delete.
	SweepDelay    = 6 * time.Minute
	MaxPresignOps = 100
	ProjectLimit  = int64(64 << 20)
	UserLimit     = int64(1 << 30)
)

// Op is what a presigned URL may do.
type Op string

const (
	OpGet    Op = "get"
	OpPut    Op = "put"
	OpDelete Op = "delete"
)

// Actor is who asks: the project's owner, whether the project is public, and
// whether this is the owner's tab the room names as the saver.
type Actor struct {
	Owner, Public, Saver bool
}

var keyForm = regexp.MustCompile(`^(?:` +
	`public/(?:structure|board)\.ybin\.gz` +
	`|private/structure\.ybin\.gz` +
	`|(?:hidden|sealed)/manifest\.json\.gz` +
	`|(?:public|hidden|sealed|private)/f/[A-Za-z0-9_-]{1,64}\.ybin\.gz` +
	`|(?:public|hidden|sealed|private)/b/[0-9a-f]{64}\.gz` +
	`|private/t/[A-Za-z0-9_-]{1,400}\.ybin\.gz` +
	`)$`)

// validKey: only the listed forms exist, always relative to the project's folder.
func validKey(key string) bool { return keyForm.MatchString(key) }

// Allowed is the access matrix of the spec.
func Allowed(op Op, key string, a Actor) bool {
	if !validKey(key) {
		return false
	}
	switch op {
	case OpGet:
		return a.Owner || (a.Public && strings.HasPrefix(key, "public/"))
	case OpPut, OpDelete:
		return a.Owner && a.Saver && !strings.HasPrefix(key, "sealed/")
	}
	return false
}
