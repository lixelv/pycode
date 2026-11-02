package projects

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/lixelv/polycode/backend/internal/identity"
	"github.com/lixelv/polycode/backend/internal/storage"
)

// SaverChecker says whether a token is the one the project's room gave its saver.
type SaverChecker interface {
	IsSaver(project uuid.UUID, token string) bool
}

const (
	// A manifest is metadata only: the one thing of a project the server reads.
	manifestLimit   = 1 << 20
	manifestUnzip   = 16 << 20
	maxBody         = 1 << 20
	copyNameRetries = 100
)

type Handlers struct {
	store    *Store
	s3       *storage.S3
	savers   SaverChecker
	onDelete func(uuid.UUID)
	// Rewriting a manifest is read, change, write.
	manifestMu sync.Mutex
	// URLs given out and maybe not used yet: a limit must count them, or many
	// requests could each pass alone. In memory, like rooms: they last 5 minutes.
	quotaMu  sync.Mutex
	reserved map[uuid.UUID]map[string]reservation
}

type reservation struct {
	size    int64
	expires time.Time
}

func NewHandlers(store *Store, s3 *storage.S3, savers SaverChecker) *Handlers {
	return &Handlers{store: store, s3: s3, savers: savers, onDelete: func(uuid.UUID) {}, reserved: map[uuid.UUID]map[string]reservation{}}
}

// OnDelete is called after a project is deleted, to close what is open on it.
func (h *Handlers) OnDelete(fn func(uuid.UUID)) { h.onDelete = fn }

func (h *Handlers) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/projects", h.list)
	mux.HandleFunc("POST /api/projects", h.create)
	mux.HandleFunc("GET /api/projects/{id}", h.get)
	mux.HandleFunc("PATCH /api/projects/{id}", h.patch)
	mux.HandleFunc("DELETE /api/projects/{id}", h.remove)
	mux.HandleFunc("POST /api/projects/{id}/presign", h.presign)
	mux.HandleFunc("GET /api/projects/{id}/keys", h.keys)
	mux.HandleFunc("POST /api/projects/{id}/visibility", h.visibility)
	mux.HandleFunc("POST /api/projects/{id}/copy", h.copy)
	mux.HandleFunc("POST /api/projects/{id}/sealed/remove", h.sealedRemove)
}

// Janitor finishes deletions once every URL given out has expired.
func (h *Handlers) Janitor(ctx context.Context) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			if err := h.Sweep(ctx, now); err != nil {
				slog.Warn("sweep projects", "err", err)
			}
		}
	}
}

// Sweep removes what a late PUT may have left, then the row.
func (h *Handlers) Sweep(ctx context.Context, now time.Time) error {
	ids, err := h.store.DeletedBefore(ctx, now.Add(-SweepDelay))
	if err != nil {
		return err
	}
	var first error
	for _, id := range ids {
		if err := h.s3.DeletePrefix(ctx, prefixOf(id)); err != nil {
			first = errors.Join(first, err)
			continue
		}
		first = errors.Join(first, h.store.Remove(ctx, id))
	}
	return first
}

func prefixOf(id uuid.UUID) string { return "projects/" + id.String() + "/" }

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

// notFound is the same for a missing project and one the caller may not see.
func notFound(w http.ResponseWriter) { writeError(w, http.StatusNotFound, "project not found") }

func internal(w http.ResponseWriter, what string, err error) {
	slog.Error(what, "err", err)
	writeError(w, http.StatusInternalServerError, "could not "+what)
}

func decode(w http.ResponseWriter, r *http.Request, into any) bool {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBody)).Decode(into); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return false
	}
	return true
}

// load finds the project in the path. Whoever may not see it gets 404.
func (h *Handlers) load(w http.ResponseWriter, r *http.Request, ownerOnly bool) (*Project, uuid.UUID, bool) {
	user := identity.FromContext(r.Context())
	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		notFound(w)
		return nil, user, false
	}
	p, err := h.store.Get(r.Context(), id)
	if errors.Is(err, ErrNotFound) {
		// Told only to its owner, whose browser may erase its copy on this and nothing less.
		if owner, deleted := h.store.DeletedOwner(r.Context(), id); deleted && owner == user {
			w.Header().Set("X-Project-Deleted", "1")
		}
		notFound(w)
		return nil, user, false
	}
	if err != nil {
		internal(w, "read the project", err)
		return nil, user, false
	}
	if p.OwnerID != user && (ownerOnly || !p.Public) {
		notFound(w)
		return nil, user, false
	}
	return p, user, true
}

type projectJSON struct {
	ID        uuid.UUID       `json:"id"`
	Name      string          `json:"name"`
	Settings  json.RawMessage `json:"settings"`
	Public    bool            `json:"public"`
	SizeBytes int64           `json:"sizeBytes"`
	OwnerID   string          `json:"ownerId"`
	Mine      bool            `json:"mine"`
	Created   time.Time       `json:"createdAt"`
	Updated   time.Time       `json:"updatedAt"`
}

func view(p *Project, user uuid.UUID) projectJSON {
	return projectJSON{p.ID, p.Name, p.Settings, p.Public, p.SizeBytes, identity.Public(p.OwnerID), p.OwnerID == user, p.Created, p.Updated}
}

func (h *Handlers) list(w http.ResponseWriter, r *http.Request) {
	user := identity.FromContext(r.Context())
	list, err := h.store.List(r.Context(), user)
	if err != nil {
		internal(w, "list projects", err)
		return
	}
	out := make([]projectJSON, len(list))
	for i, p := range list {
		out[i] = view(p, user)
	}
	writeJSON(w, http.StatusOK, map[string]any{"projects": out})
}

func (h *Handlers) create(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name string `json:"name"`
	}
	if !decode(w, r, &body) {
		return
	}
	if !ValidName(body.Name) {
		writeError(w, http.StatusBadRequest, "a project's name takes 1 to 100 characters")
		return
	}
	user := identity.FromContext(r.Context())
	p, err := h.store.Create(r.Context(), user, body.Name, nil, 0)
	if errors.Is(err, ErrNameTaken) {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	if err != nil {
		internal(w, "create the project", err)
		return
	}
	writeJSON(w, http.StatusCreated, view(p, user))
}

func (h *Handlers) get(w http.ResponseWriter, r *http.Request) {
	if p, user, ok := h.load(w, r, false); ok {
		writeJSON(w, http.StatusOK, view(p, user))
	}
}

func (h *Handlers) patch(w http.ResponseWriter, r *http.Request) {
	p, user, ok := h.load(w, r, true)
	if !ok {
		return
	}
	var body struct {
		Name     *string `json:"name"`
		Settings *struct {
			AskName bool `json:"askName"`
		} `json:"settings"`
	}
	if !decode(w, r, &body) {
		return
	}
	if body.Name != nil && !ValidName(*body.Name) {
		writeError(w, http.StatusBadRequest, "a project's name takes 1 to 100 characters")
		return
	}
	var settings json.RawMessage
	if body.Settings != nil {
		settings, _ = json.Marshal(body.Settings)
	}
	next, err := h.store.Update(r.Context(), user, p.ID, body.Name, settings)
	if errors.Is(err, ErrNameTaken) {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	if err != nil {
		internal(w, "change the project", err)
		return
	}
	writeJSON(w, http.StatusOK, view(next, user))
}

func (h *Handlers) visibility(w http.ResponseWriter, r *http.Request) {
	p, user, ok := h.load(w, r, true)
	if !ok {
		return
	}
	var body struct {
		Public bool `json:"public"`
	}
	if !decode(w, r, &body) {
		return
	}
	next, err := h.store.SetPublic(r.Context(), user, p.ID, body.Public)
	if err != nil {
		internal(w, "change the visibility", err)
		return
	}
	writeJSON(w, http.StatusOK, view(next, user))
}

// Delete deletes a user's project: the row first, so no URL is given out while
// the objects go. Used by the page and by the agent's delete_project alike.
func (h *Handlers) Delete(ctx context.Context, owner, id uuid.UUID) error {
	if err := h.store.MarkDeleted(ctx, owner, id); err != nil {
		return err
	}
	h.quotaMu.Lock()
	delete(h.reserved, id)
	h.quotaMu.Unlock()
	// A failure here is repeated by the janitor.
	if err := h.s3.DeletePrefix(ctx, prefixOf(id)); err != nil {
		slog.Warn("delete project objects", "project", id, "err", err)
	}
	h.onDelete(id)
	return nil
}

func (h *Handlers) remove(w http.ResponseWriter, r *http.Request) {
	p, user, ok := h.load(w, r, true)
	if !ok {
		return
	}
	if err := h.Delete(r.Context(), user, p.ID); err != nil {
		internal(w, "delete the project", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handlers) keys(w http.ResponseWriter, r *http.Request) {
	p, _, ok := h.load(w, r, true)
	if !ok {
		return
	}
	objects, err := h.s3.List(r.Context(), prefixOf(p.ID))
	if err != nil {
		internal(w, "list the project's objects", err)
		return
	}
	type keyJSON struct {
		Key  string `json:"key"`
		Size int64  `json:"size"`
	}
	out := make([]keyJSON, len(objects))
	for i, o := range objects {
		out[i] = keyJSON{strings.TrimPrefix(o.Key, prefixOf(p.ID)), o.Size}
	}
	writeJSON(w, http.StatusOK, map[string]any{"keys": out})
}

type presignOp struct {
	Op   Op     `json:"op"`
	Key  string `json:"key"`
	Size *int64 `json:"size"`
}

func (h *Handlers) presign(w http.ResponseWriter, r *http.Request) {
	p, user, ok := h.load(w, r, false)
	if !ok {
		return
	}
	var body struct {
		SaverToken string      `json:"saverToken"`
		Ops        []presignOp `json:"ops"`
	}
	if !decode(w, r, &body) {
		return
	}
	if len(body.Ops) > MaxPresignOps {
		writeError(w, http.StatusBadRequest, "too many operations")
		return
	}
	owner := p.OwnerID == user
	actor := Actor{Owner: owner, Public: p.Public, Saver: owner && h.savers.IsSaver(p.ID, body.SaverToken)}
	puts := map[string]int64{}
	deletes := map[string]bool{}
	for _, op := range body.Ops {
		if !validKey(op.Key) || (op.Op != OpGet && op.Op != OpPut && op.Op != OpDelete) {
			writeError(w, http.StatusBadRequest, "invalid operation")
			return
		}
		if op.Op == OpPut && (op.Size == nil || *op.Size < 0) {
			writeError(w, http.StatusBadRequest, "a put needs its size")
			return
		}
		if !Allowed(op.Op, op.Key, actor) {
			if !owner {
				notFound(w)
			} else {
				writeError(w, http.StatusForbidden, "this tab does not save this project")
			}
			return
		}
		switch op.Op {
		case OpPut:
			puts[op.Key] = *op.Size
		case OpDelete:
			deletes[op.Key] = true
		}
	}
	// What is being deleted no longer needs its place held.
	h.quotaMu.Lock()
	for key := range deletes {
		delete(h.reserved[p.ID], key)
	}
	h.quotaMu.Unlock()
	if len(puts) > 0 {
		if status, err := h.checkQuota(r.Context(), p, puts, deletes); err != nil {
			if status == http.StatusInternalServerError {
				internal(w, "check the quota", err)
			} else {
				writeError(w, status, err.Error())
			}
			return
		}
	}
	type urlJSON struct {
		Key string `json:"key"`
		URL string `json:"url"`
	}
	urls := make([]urlJSON, 0, len(body.Ops))
	for _, op := range body.Ops {
		key := prefixOf(p.ID) + op.Key
		var u string
		var err error
		switch op.Op {
		case OpGet:
			u, err = h.s3.PresignGet(r.Context(), key, PresignTTL)
		case OpPut:
			u, err = h.s3.PresignPut(r.Context(), key, *op.Size, PresignTTL)
		case OpDelete:
			u, err = h.s3.PresignDelete(r.Context(), key, PresignTTL)
		}
		if err != nil {
			internal(w, "sign the request", err)
			return
		}
		urls = append(urls, urlJSON{op.Key, u})
	}
	writeJSON(w, http.StatusOK, map[string]any{"urls": urls})
}

// movable: a file's object, which a change of visibility moves between prefixes.
// New object first, old one last, with other writes between: it counts once all that time.
var movable = regexp.MustCompile(`^(?:public|hidden|private)/((?:f|b)/.+)$`)

// checkQuota counts what is stored now and the URLs still out, without what these
// operations replace, plus the declared sizes. A URL is signed for its size, so S3
// holds them to it. On success the sizes are reserved until the URLs expire.
func (h *Handlers) checkQuota(ctx context.Context, p *Project, puts map[string]int64, deletes map[string]bool) (int, error) {
	h.quotaMu.Lock()
	defer h.quotaMu.Unlock()
	objects, err := h.s3.List(ctx, prefixOf(p.ID))
	if err != nil {
		return http.StatusInternalServerError, err
	}
	now := time.Now()
	outstanding := h.reserved[p.ID]
	if outstanding == nil {
		outstanding = map[string]reservation{}
		h.reserved[p.ID] = outstanding
	}
	counted := map[string]int64{}
	for _, o := range objects {
		counted[strings.TrimPrefix(o.Key, prefixOf(p.ID))] = o.Size
	}
	for key, r := range outstanding {
		if now.After(r.expires) {
			delete(outstanding, key)
		} else {
			counted[key] = r.size
		}
	}
	for key, size := range puts {
		counted[key] = size
	}
	for key := range deletes {
		if _, put := puts[key]; !put {
			delete(counted, key)
		}
	}
	var total int64
	largest := map[string]int64{}
	for key, size := range counted {
		if m := movable.FindStringSubmatch(key); m != nil {
			largest[m[1]] = max(largest[m[1]], size)
		} else {
			total += size
		}
	}
	for _, size := range largest {
		total += size
	}
	if total > ProjectLimit {
		return http.StatusRequestEntityTooLarge, errors.New("the project is over its limit of 64 MB")
	}
	others, err := h.store.UsedByOthers(ctx, p.OwnerID, p.ID)
	if err != nil {
		return http.StatusInternalServerError, err
	}
	if others+total > UserLimit {
		return http.StatusRequestEntityTooLarge, errors.New("your projects are over their limit of 1 GB")
	}
	if err := h.store.SetSize(ctx, p.ID, total); err != nil {
		return http.StatusInternalServerError, err
	}
	for key, size := range puts {
		outstanding[key] = reservation{size, now.Add(PresignTTL)}
	}
	return http.StatusOK, nil
}

// ---- manifests -------------------------------------------------------------------

// manifestEntry keeps every field a manifest holds; only these are looked at.
type manifestEntry struct {
	Path string `json:"path"`
	ID   string `json:"id"`
	Kind string `json:"kind"`
	Size int64  `json:"size"`
	Hash string `json:"hash,omitempty"`
	Mime string `json:"mime,omitempty"`
}

func (h *Handlers) readManifest(ctx context.Context, key string) ([]manifestEntry, error) {
	data, err := h.s3.ReadSmall(ctx, key, manifestLimit)
	if storage.IsNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	r, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	var out []manifestEntry
	if err := json.NewDecoder(io.LimitReader(r, manifestUnzip)).Decode(&out); err != nil {
		return nil, err
	}
	return out, nil
}

func (h *Handlers) writeManifest(ctx context.Context, key string, entries []manifestEntry) error {
	if entries == nil {
		entries = []manifestEntry{}
	}
	var buf bytes.Buffer
	w := gzip.NewWriter(&buf)
	if err := json.NewEncoder(w).Encode(entries); err != nil {
		return err
	}
	if err := w.Close(); err != nil {
		return err
	}
	return h.s3.WriteSmall(ctx, key, buf.Bytes())
}

// sealedRemove: a sealed file gave way to a new one under its path. The owner
// may not write sealed/, so the server drops the entry and the objects.
func (h *Handlers) sealedRemove(w http.ResponseWriter, r *http.Request) {
	p, _, ok := h.load(w, r, true)
	if !ok {
		return
	}
	var body struct {
		SaverToken string   `json:"saverToken"`
		Paths      []string `json:"paths"`
	}
	if !decode(w, r, &body) {
		return
	}
	if !h.savers.IsSaver(p.ID, body.SaverToken) {
		writeError(w, http.StatusForbidden, "this tab does not save this project")
		return
	}
	h.manifestMu.Lock()
	defer h.manifestMu.Unlock()
	ctx := r.Context()
	key := prefixOf(p.ID) + "sealed/manifest.json.gz"
	entries, err := h.readManifest(ctx, key)
	if err != nil {
		internal(w, "read the manifest", err)
		return
	}
	gone := map[string]bool{}
	for _, path := range body.Paths {
		gone[path] = true
	}
	kept := []manifestEntry{}
	var removed []manifestEntry
	for _, e := range entries {
		if gone[e.Path] {
			removed = append(removed, e)
		} else {
			kept = append(kept, e)
		}
	}
	if len(removed) == 0 {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if err := h.writeManifest(ctx, key, kept); err != nil {
		internal(w, "write the manifest", err)
		return
	}
	for _, e := range removed {
		object := "sealed/f/" + e.ID + ".ybin.gz"
		if e.Hash != "" {
			object = "sealed/b/" + e.Hash + ".gz"
			if blobUsed(kept, e.Hash) {
				continue
			}
		}
		// A manifest's strings came from a browser: only real keys are touched.
		if !validKey(object) {
			continue
		}
		if err := h.s3.Delete(ctx, prefixOf(p.ID)+object); err != nil {
			slog.Warn("delete sealed object", "project", p.ID, "err", err)
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

func blobUsed(entries []manifestEntry, hash string) bool {
	for _, e := range entries {
		if e.Hash == hash {
			return true
		}
	}
	return false
}

// ---- copying ---------------------------------------------------------------------

// copyTarget says where an object of the source goes: public/ stays, hidden/ and
// sealed/ become sealed/, private/ stays behind. Manifests are merged apart.
func copyTarget(key string) (string, bool) {
	if !validKey(key) || strings.HasSuffix(key, "/manifest.json.gz") {
		return "", false
	}
	switch {
	case strings.HasPrefix(key, "public/"), strings.HasPrefix(key, "sealed/"):
		return key, true
	case strings.HasPrefix(key, "hidden/"):
		return "sealed/" + strings.TrimPrefix(key, "hidden/"), true
	}
	return "", false
}

func (h *Handlers) copy(w http.ResponseWriter, r *http.Request) {
	source, user, ok := h.load(w, r, false)
	if !ok {
		return
	}
	ctx := r.Context()
	prefix := prefixOf(source.ID)
	objects, err := h.s3.List(ctx, prefix)
	if err != nil {
		internal(w, "list the project's objects", err)
		return
	}
	hidden, err := h.readManifest(ctx, prefix+"hidden/manifest.json.gz")
	if err == nil {
		var sealed []manifestEntry
		sealed, err = h.readManifest(ctx, prefix+"sealed/manifest.json.gz")
		hidden = mergeManifests(hidden, sealed)
	}
	if errors.Is(err, storage.ErrTooLarge) {
		writeError(w, http.StatusRequestEntityTooLarge, "this project's manifest is too large")
		return
	}
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "this project's manifest cannot be read")
		return
	}
	moves := map[string]string{}
	sizes := map[string]int64{}
	for _, o := range objects {
		key := strings.TrimPrefix(o.Key, prefix)
		if to, ok := copyTarget(key); ok {
			moves[key] = to
			sizes[to] = o.Size
		}
	}
	var size int64
	for _, s := range sizes {
		size += s
	}
	used, err := h.store.UsedByOthers(ctx, user, uuid.Nil)
	if err != nil {
		internal(w, "check the quota", err)
		return
	}
	if used+size > UserLimit {
		writeError(w, http.StatusRequestEntityTooLarge, "your projects are over their limit of 1 GB")
		return
	}
	var copied *Project
	for attempt := range copyNameRetries {
		copied, err = h.store.Create(ctx, user, CopyName(source.Name, attempt), &source.ID, size)
		if !errors.Is(err, ErrNameTaken) {
			break
		}
	}
	if err != nil {
		internal(w, "create the copy", err)
		return
	}
	target := prefixOf(copied.ID)
	err = nil
	for from, to := range moves {
		if err = h.s3.Copy(ctx, prefix+from, target+to); err != nil {
			break
		}
	}
	if err == nil && hidden != nil {
		err = h.writeManifest(ctx, target+"sealed/manifest.json.gz", hidden)
	}
	if err != nil {
		// Half a copy is no copy.
		_ = h.Delete(context.WithoutCancel(ctx), user, copied.ID)
		internal(w, "copy the project", err)
		return
	}
	writeJSON(w, http.StatusCreated, view(copied, user))
}

// mergeManifests keeps one entry per path, the hidden file over the sealed one:
// the owner of the source replaced that file.
func mergeManifests(hidden, sealed []manifestEntry) []manifestEntry {
	if hidden == nil && sealed == nil {
		return nil
	}
	seen := map[string]bool{}
	out := []manifestEntry{}
	for _, list := range [][]manifestEntry{hidden, sealed} {
		for _, e := range list {
			if !seen[e.Path] {
				seen[e.Path] = true
				out = append(out, e)
			}
		}
	}
	return out
}
