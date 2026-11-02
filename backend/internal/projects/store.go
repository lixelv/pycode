package projects

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Project is one live row of the projects table.
type Project struct {
	ID         uuid.UUID
	OwnerID    uuid.UUID
	Name       string
	Settings   json.RawMessage
	Public     bool
	SizeBytes  int64
	CopiedFrom *uuid.UUID
	Created    time.Time
	Updated    time.Time
}

var (
	ErrNotFound  = errors.New("project not found")
	ErrNameTaken = errors.New("a project with this name already exists")
)

type Store struct{ pool *pgxpool.Pool }

func NewStore(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

const columns = `id, owner_id, name, settings, is_public, size_bytes, copied_from, created_at, updated_at`

func scan(row pgx.Row) (*Project, error) {
	var p Project
	err := row.Scan(&p.ID, &p.OwnerID, &p.Name, &p.Settings, &p.Public, &p.SizeBytes, &p.CopiedFrom, &p.Created, &p.Updated)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &p, nil
}

// ValidName: 1 to 100 characters.
func ValidName(name string) bool {
	n := utf8.RuneCountInString(name)
	return n >= 1 && n <= 100
}

func nameErr(err error) error {
	var pg *pgconn.PgError
	if errors.As(err, &pg) && pg.Code == "23505" {
		return ErrNameTaken
	}
	return err
}

func (s *Store) Create(ctx context.Context, owner uuid.UUID, name string, copiedFrom *uuid.UUID, size int64) (*Project, error) {
	row := s.pool.QueryRow(ctx,
		`INSERT INTO projects (id, owner_id, name, copied_from, size_bytes) VALUES ($1, $2, $3, $4, $5) RETURNING `+columns,
		uuid.Must(uuid.NewV7()), owner, name, copiedFrom, size)
	p, err := scan(row)
	return p, nameErr(err)
}

// Get finds a live project, whoever asks: the caller decides who may see it.
func (s *Store) Get(ctx context.Context, id uuid.UUID) (*Project, error) {
	return scan(s.pool.QueryRow(ctx, `SELECT `+columns+` FROM projects WHERE id = $1 AND deleted_at IS NULL`, id))
}

func (s *Store) List(ctx context.Context, owner uuid.UUID) ([]*Project, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+columns+` FROM projects WHERE owner_id = $1 AND deleted_at IS NULL ORDER BY updated_at DESC, id`, owner)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*Project{}
	for rows.Next() {
		p, err := scan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// Update changes what is given (nil stays) on an owner's live project.
func (s *Store) Update(ctx context.Context, owner, id uuid.UUID, name *string, settings json.RawMessage) (*Project, error) {
	row := s.pool.QueryRow(ctx,
		`UPDATE projects SET name = COALESCE($3, name), settings = COALESCE($4::jsonb, settings), updated_at = now()
		 WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL RETURNING `+columns,
		id, owner, name, nullableJSON(settings))
	p, err := scan(row)
	return p, nameErr(err)
}

func nullableJSON(data json.RawMessage) *string {
	if data == nil {
		return nil
	}
	text := string(data)
	return &text
}

func (s *Store) SetPublic(ctx context.Context, owner, id uuid.UUID, public bool) (*Project, error) {
	return scan(s.pool.QueryRow(ctx,
		`UPDATE projects SET is_public = $3, updated_at = now() WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL RETURNING `+columns,
		id, owner, public))
}

func (s *Store) SetSize(ctx context.Context, id uuid.UUID, size int64) error {
	_, err := s.pool.Exec(ctx, `UPDATE projects SET size_bytes = $2, updated_at = now() WHERE id = $1 AND deleted_at IS NULL`, id, size)
	return err
}

// UsedByOthers is what a user's other projects take.
func (s *Store) UsedByOthers(ctx context.Context, owner, except uuid.UUID) (int64, error) {
	var used int64
	err := s.pool.QueryRow(ctx,
		`SELECT COALESCE(SUM(size_bytes), 0) FROM projects WHERE owner_id = $1 AND id <> $2 AND deleted_at IS NULL`, owner, except).Scan(&used)
	return used, err
}

// DeletedOwner says whose this project was, if it is deleted and not swept yet.
func (s *Store) DeletedOwner(ctx context.Context, id uuid.UUID) (uuid.UUID, bool) {
	var owner uuid.UUID
	err := s.pool.QueryRow(ctx, `SELECT owner_id FROM projects WHERE id = $1 AND deleted_at IS NOT NULL`, id).Scan(&owner)
	return owner, err == nil
}

// MarkDeleted makes the project gone for everyone; its name is free at once.
func (s *Store) MarkDeleted(ctx context.Context, owner, id uuid.UUID) error {
	tag, err := s.pool.Exec(ctx, `UPDATE projects SET deleted_at = now() WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL`, id, owner)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// DeletedBefore lists projects deleted at or before t.
func (s *Store) DeletedBefore(ctx context.Context, t time.Time) ([]uuid.UUID, error) {
	rows, err := s.pool.Query(ctx, `SELECT id FROM projects WHERE deleted_at IS NOT NULL AND deleted_at <= $1`, t)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
}

func (s *Store) Remove(ctx context.Context, id uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM projects WHERE id = $1 AND deleted_at IS NOT NULL`, id)
	return err
}

// CopyName is a free name for a copy of a project: "a (copy)", "a (copy 2)"...
func CopyName(name string, attempt int) string {
	suffix := " (copy)"
	if attempt > 0 {
		suffix = fmt.Sprintf(" (copy %d)", attempt+1)
	}
	runes := []rune(name)
	if room := 100 - utf8.RuneCountInString(suffix); len(runes) > room {
		runes = runes[:room]
	}
	return string(runes) + suffix
}
