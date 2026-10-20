package session

import (
	"context"
	"crypto/rand"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Session is one row of the sessions table.
type Session struct {
	ID      uuid.UUID  `json:"id"`
	Code    string     `json:"code"`
	OwnerID uuid.UUID  `json:"ownerId"`
	Mode    string     `json:"mode"`
	EndedAt *time.Time `json:"endedAt,omitempty"`
	Created time.Time  `json:"createdAt"`
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

func (s *Store) Create(ctx context.Context, owner uuid.UUID, mode string) (*Session, error) {
	sess := &Session{ID: uuid.Must(uuid.NewV7()), OwnerID: owner, Mode: mode, Created: time.Now()}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	for attempt := 0; ; attempt++ {
		sess.Code = newCode()
		tag, err := tx.Exec(ctx,
			`INSERT INTO sessions (id, code, owner_id, mode) VALUES ($1, $2, $3, $4) ON CONFLICT (code) DO NOTHING`,
			sess.ID, sess.Code, owner, mode)
		if err != nil {
			return nil, err
		}
		if tag.RowsAffected() == 1 {
			break
		}
		if attempt > 5 {
			return nil, errors.New("could not allocate a session code")
		}
	}
	return sess, tx.Commit(ctx)
}

func (s *Store) ByCode(ctx context.Context, code string) (*Session, error) {
	var sess Session
	err := s.pool.QueryRow(ctx,
		`SELECT id, code, owner_id, mode, ended_at, created_at FROM sessions WHERE code = $1`, NormalizeCode(code),
	).Scan(&sess.ID, &sess.Code, &sess.OwnerID, &sess.Mode, &sess.EndedAt, &sess.Created)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	return &sess, err
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
