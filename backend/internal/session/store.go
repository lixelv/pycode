package session

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lixelv/python-coder/backend/internal/identity"
)

// Session is one row of the sessions table. Code is the code it was looked
// up by (each role has its own).
type Session struct {
	ID      uuid.UUID  `json:"id"`
	Code    string     `json:"code"`
	OwnerID uuid.UUID  `json:"-"`
	AskName bool       `json:"askName"`
	EndedAt *time.Time `json:"endedAt,omitempty"`
	Created time.Time  `json:"createdAt"`
}

// MarshalJSON names the owner by public id (see identity.Public).
func (s Session) MarshalJSON() ([]byte, error) {
	type plain Session
	return json.Marshal(struct {
		plain
		Owner string `json:"ownerId"`
	}{plain(s), identity.Public(s.OwnerID)})
}

// Code is the join code of one role.
type Code struct {
	Role  string `json:"role"`
	Level string `json:"level"`
	Code  string `json:"code"`
}

var ErrNotFound = errors.New("session not found")

type Store struct{ pool *pgxpool.Pool }

// Codes avoid look-alike characters (0/O, 1/I/L).
const codeAlphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

func newCode() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	for i := range b {
		b[i] = codeAlphabet[int(b[i])%len(codeAlphabet)]
	}
	return string(b)
}

// NormalizeCode accepts "abcd-efgh", "ABCD EFGH" or a full link's last part.
func NormalizeCode(raw string) string {
	raw = strings.ToUpper(raw)
	var b strings.Builder
	for _, r := range raw {
		if strings.ContainsRune(codeAlphabet, r) {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// Create makes a session with codes for read, write, admin and the given custom roles.
func (s *Store) Create(ctx context.Context, owner uuid.UUID, askName bool, roles []Code) (*Session, []Code, error) {
	sess := &Session{ID: uuid.Must(uuid.NewV7()), OwnerID: owner, AskName: askName, Created: time.Now()}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, nil, err
	}
	defer tx.Rollback(ctx)
	for attempt := 0; ; attempt++ {
		sess.Code = newCode()
		tag, err := tx.Exec(ctx,
			`INSERT INTO sessions (id, code, owner_id, mode, ask_name) VALUES ($1, $2, $3, 'read_write', $4) ON CONFLICT (code) DO NOTHING`,
			sess.ID, sess.Code, owner, askName)
		if err != nil {
			return nil, nil, err
		}
		if tag.RowsAffected() == 1 {
			break
		}
		if attempt > 5 {
			return nil, nil, errors.New("could not allocate a session code")
		}
	}
	all := append([]Code{{Role: RoleWrite, Level: LevelWrite, Code: sess.Code}, {Role: RoleRead, Level: LevelRead}, {Role: RoleAdmin, Level: LevelAdmin}}, roles...)
	codes := make([]Code, 0, len(all))
	for _, c := range all {
		c, err := addCode(ctx, tx, sess.ID, c)
		if err != nil {
			return nil, nil, err
		}
		codes = append(codes, c)
	}
	return sess, codes, tx.Commit(ctx)
}

type execer interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// addCode gives a role a join code (c.Code if set, else a fresh one), or
// returns the code the role already has.
func addCode(ctx context.Context, db execer, session uuid.UUID, c Code) (Code, error) {
	for attempt := 0; ; attempt++ {
		code := c.Code
		if code == "" {
			code = newCode()
		}
		tag, err := db.Exec(ctx,
			`INSERT INTO session_codes (code, session_id, role, level) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
			code, session, c.Role, c.Level)
		if err != nil {
			return c, err
		}
		if tag.RowsAffected() == 1 {
			c.Code = code
			return c, nil
		}
		var existing Code
		err = db.QueryRow(ctx, `SELECT role, level, code FROM session_codes WHERE session_id = $1 AND role = $2`, session, c.Role).
			Scan(&existing.Role, &existing.Level, &existing.Code)
		if err == nil {
			return existing, nil
		}
		if attempt > 5 {
			return c, errors.New("could not allocate a code")
		}
	}
}

// AddRole gives a custom role a code (or returns the one it has).
func (s *Store) AddRole(ctx context.Context, session uuid.UUID, c Code) (Code, error) {
	c.Code = ""
	return addCode(ctx, s.pool, session, c)
}

// Codes lists every role's code of a session.
func (s *Store) Codes(ctx context.Context, session uuid.UUID) ([]Code, error) {
	rows, err := s.pool.Query(ctx, `SELECT role, level, code FROM session_codes WHERE session_id = $1 ORDER BY role`, session)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (Code, error) {
		var c Code
		return c, row.Scan(&c.Role, &c.Level, &c.Code)
	})
}

// SetMemberGrant records the level and roles given to a user in a session.
func (s *Store) SetMemberGrant(ctx context.Context, session, user uuid.UUID, g grant) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO session_members (session_id, user_id, level, roles) VALUES ($1, $2, $3, $4)
		 ON CONFLICT (session_id, user_id) DO UPDATE SET level = EXCLUDED.level, roles = EXCLUDED.roles`,
		session, user, g.Level, g.Roles)
	return err
}

// MemberGrant is what was given to a user in a session, if anything.
func (s *Store) MemberGrant(ctx context.Context, session, user uuid.UUID) (grant, bool) {
	var g grant
	err := s.pool.QueryRow(ctx, `SELECT level, roles FROM session_members WHERE session_id = $1 AND user_id = $2`, session, user).
		Scan(&g.Level, &g.Roles)
	return g, err == nil
}

// ByCode finds a session by any of its codes, with the role that code gives.
func (s *Store) ByCode(ctx context.Context, code string) (*Session, Code, error) {
	var sess Session
	var c Code
	err := s.pool.QueryRow(ctx,
		`SELECT s.id, c.code, s.owner_id, s.ask_name, s.ended_at, s.created_at, c.role, c.level
		   FROM session_codes c JOIN sessions s ON s.id = c.session_id WHERE c.code = $1`, NormalizeCode(code),
	).Scan(&sess.ID, &sess.Code, &sess.OwnerID, &sess.AskName, &sess.EndedAt, &sess.Created, &c.Role, &c.Level)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, c, ErrNotFound
	}
	c.Code = sess.Code
	return &sess, c, err
}

func (s *Store) End(ctx context.Context, id uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `UPDATE sessions SET ended_at = now() WHERE id = $1 AND ended_at IS NULL`, id)
	return err
}

func (s *Store) Touch(ctx context.Context, ids []uuid.UUID) error {
	if len(ids) == 0 {
		return nil
	}
	_, err := s.pool.Exec(ctx, `UPDATE sessions SET last_active = now() WHERE id = ANY($1)`, ids)
	return err
}

// Expire deletes sessions idle for longer than ttl (and ended ones after a day).
func (s *Store) Expire(ctx context.Context, ttl time.Duration) (int64, error) {
	tag, err := s.pool.Exec(ctx,
		`DELETE FROM sessions WHERE last_active < now() - make_interval(secs => $1) OR ended_at < now() - interval '1 day'`,
		ttl.Seconds())
	return tag.RowsAffected(), err
}
