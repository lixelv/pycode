package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"sync"
	"time"

	"github.com/google/uuid"
)

// The tabs of /mcp-driven, the only place an agent works. Everything is in
// memory of this one backend, like the session rooms: after a restart the tabs
// connect again and take their projects back. One lock makes "at most one tab
// per project" atomic.

var (
	errNoTabs    = errors.New("Нет открытых вкладок /mcp-driven. Попроси пользователя нажать кнопку с роботом в polycode.")
	errNeedOpen  = errors.New("Вызови open_project(project, tab_id). Список вкладок — list_tabs, проектов — list_projects.")
	errClosed    = errors.New("вкладка закрылась, вызов мог выполниться или нет. Текущая вкладка сброшена: вызови open_project.")
	errSwitching = errors.New("вкладка переключается, повтори вызов через несколько секунд.")
	errTimeout   = errors.New("вкладка не ответила вовремя")
)

// TabInfo is one open tab and its project.
type TabInfo struct {
	ID      string
	Project *uuid.UUID
}

type answer struct {
	data json.RawMessage
	err  error
}

type pendingCall struct {
	done chan answer
}

type switching struct {
	to   uuid.UUID
	done chan error
}

type tabState struct {
	user uuid.UUID
	id   string
	// send is nil while a switching tab reloads.
	send func([]byte) error
	kick func()
	// conn tells this tab's connections apart: a late close or answer of an
	// old one does nothing.
	conn     uint64
	project  *uuid.UUID
	switched *switching
	calls    map[uint64]*pendingCall
}

type holder struct {
	user uuid.UUID
	tab  string
}

type Registry struct {
	mu      sync.Mutex
	users   map[uuid.UUID]map[string]*tabState
	holders map[uuid.UUID]holder
	nextID  uint64
}

func NewRegistry() *Registry {
	return &Registry{users: map[uuid.UUID]map[string]*tabState{}, holders: map[uuid.UUID]holder{}}
}

// Attach connects a tab. A connection under an id already there is the same page
// reloaded (a duplicate takes a new id): it pushes the old one out and keeps the
// tab's project. The result is the detach to call when this connection closes.
func (r *Registry) Attach(user uuid.UUID, tab string, send func([]byte) error) (detach func()) {
	detach, _ = r.attach(user, tab, send, nil)
	return detach
}

func (r *Registry) attach(user uuid.UUID, tab string, send func([]byte) error, kick func()) (func(), uint64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	tabs := r.users[user]
	if tabs == nil {
		tabs = map[string]*tabState{}
		r.users[user] = tabs
	}
	st := tabs[tab]
	if st == nil {
		st = &tabState{user: user, id: tab, calls: map[uint64]*pendingCall{}}
		tabs[tab] = st
	} else {
		st.failCalls(errClosed)
		if st.kick != nil {
			st.kick()
		}
	}
	r.nextID++
	conn := r.nextID
	st.conn, st.send, st.kick = conn, send, kick
	r.broadcast(user)
	return func() { r.detach(st, conn) }, conn
}

func (r *Registry) detach(st *tabState, conn uint64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if st.conn != conn {
		return
	}
	st.failCalls(errClosed)
	st.send, st.kick = nil, nil
	// A tab told to open a project reloads now: it comes back under this id.
	if st.switched != nil {
		return
	}
	r.drop(st)
}

func (r *Registry) drop(st *tabState) {
	r.free(st)
	if tabs := r.users[st.user]; tabs[st.id] == st {
		delete(tabs, st.id)
		if len(tabs) == 0 {
			delete(r.users, st.user)
		}
	}
	r.broadcast(st.user)
}

// free lets go of the tab's project. Call with r.mu held.
func (r *Registry) free(st *tabState) {
	if st.project != nil {
		delete(r.holders, *st.project)
		st.project = nil
	}
}

func (st *tabState) failCalls(err error) {
	for id, call := range st.calls {
		delete(st.calls, id)
		call.done <- answer{err: err}
	}
}

func (r *Registry) tab(user uuid.UUID, tab string) *tabState { return r.users[user][tab] }

// Claim takes a project for a tab; a refusal names who has it.
func (r *Registry) Claim(user uuid.UUID, tab string, project uuid.UUID) (ok bool, heldBy string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	st := r.tab(user, tab)
	if st == nil {
		return false, ""
	}
	if h, taken := r.holders[project]; taken {
		if h.user != user {
			return false, ""
		}
		return h.tab == tab, h.tab
	}
	if st.switched != nil {
		return false, tab
	}
	r.free(st)
	r.holders[project] = holder{user, tab}
	st.project = &project
	r.broadcast(user)
	return true, tab
}

// Release is the person leaving for the list.
func (r *Registry) Release(user uuid.UUID, tab string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if st := r.tab(user, tab); st != nil && st.switched == nil {
		r.free(st)
		r.broadcast(user)
	}
}

// ready is what a tab says once its page holds a project.
func (r *Registry) ready(user uuid.UUID, tab string, project *uuid.UUID) {
	r.mu.Lock()
	defer r.mu.Unlock()
	st := r.tab(user, tab)
	if st == nil {
		return
	}
	if st.switched == nil {
		if project == nil {
			r.free(st)
			r.broadcast(user)
		}
		return
	}
	if project == nil || *project != st.switched.to {
		return
	}
	to := st.switched.to
	done := st.switched.done
	st.switched = nil
	r.free(st)
	r.holders[to] = holder{user, tab}
	st.project = &to
	r.broadcast(user)
	done <- nil
}

// openFailed: the tab could not save its project and stays on it.
func (r *Registry) openFailed(user uuid.UUID, tab string, message string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if st := r.tab(user, tab); st != nil && st.switched != nil {
		r.endSwitch(st, errors.New(message))
	}
}

func (r *Registry) endSwitch(st *tabState, err error) {
	sw := st.switched
	st.switched = nil
	if h := r.holders[sw.to]; h.user == st.user && h.tab == st.id {
		delete(r.holders, sw.to)
	}
	sw.done <- err
	// It went to reload and never came back.
	if st.send == nil {
		r.drop(st)
		return
	}
	r.broadcast(st.user)
}

// open moves a tab to a project and waits for it: the new project is held at
// once, the old one until the tab says it is ready.
func (r *Registry) open(ctx context.Context, user uuid.UUID, tab string, project uuid.UUID, timeout time.Duration) (already bool, err error) {
	r.mu.Lock()
	st := r.tab(user, tab)
	if st == nil {
		r.mu.Unlock()
		return false, errors.New("Нет вкладки " + tab + ". Открытые вкладки покажет list_tabs.")
	}
	if st.switched != nil {
		r.mu.Unlock()
		return false, errSwitching
	}
	if h, taken := r.holders[project]; taken {
		r.mu.Unlock()
		if h.tab == tab {
			return true, nil
		}
		return false, errors.New("Проект открыт во вкладке " + h.tab + ". Вызови open_project с этим tab_id.")
	}
	sw := &switching{to: project, done: make(chan error, 1)}
	st.switched = sw
	r.holders[project] = holder{user, tab}
	frame, _ := json.Marshal(map[string]any{"type": "open", "project": project})
	_ = st.send(frame)
	r.broadcast(user)
	r.mu.Unlock()

	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case err := <-sw.done:
		return false, err
	case <-timer.C:
		err = errors.New("вкладка не открыла проект вовремя")
	case <-ctx.Done():
		err = errTimeout
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if st.switched == sw {
		r.endSwitch(st, err)
		return false, err
	}
	return false, <-sw.done // it finished meanwhile
}

// ProjectGone: a project was deleted. Its tab stays, without a project.
func (r *Registry) ProjectGone(project uuid.UUID) {
	r.mu.Lock()
	defer r.mu.Unlock()
	h, ok := r.holders[project]
	if !ok {
		return
	}
	st := r.tab(h.user, h.tab)
	if st == nil {
		delete(r.holders, project)
		return
	}
	if st.switched != nil && st.switched.to == project {
		r.endSwitch(st, errors.New("проект удалён"))
		return
	}
	delete(r.holders, project)
	st.project = nil
	frame, _ := json.Marshal(map[string]any{"type": "none"})
	if st.send != nil {
		_ = st.send(frame)
	}
	r.broadcast(h.user)
}

// Tabs lists a user's tabs by id. A tab reloading into a project is still one.
func (r *Registry) Tabs(user uuid.UUID) []TabInfo {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.tabsOf(user)
}

func (r *Registry) tabsOf(user uuid.UUID) []TabInfo {
	out := make([]TabInfo, 0, len(r.users[user]))
	for id, st := range r.users[user] {
		info := TabInfo{ID: id}
		if st.project != nil {
			project := *st.project
			info.Project = &project
		}
		out = append(out, info)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// broadcast tells every tab of the user who holds what, for the lists they show.
func (r *Registry) broadcast(user uuid.UUID) {
	type entry struct {
		TabID   string     `json:"tab_id"`
		Project *uuid.UUID `json:"project"`
	}
	tabs := r.tabsOf(user)
	list := make([]entry, 0, len(tabs))
	for _, t := range tabs {
		list = append(list, entry{t.ID, t.Project})
	}
	for project, h := range r.holders {
		if h.user != user {
			continue
		}
		// A project being opened counts as taken too.
		held := false
		for _, e := range list {
			if e.Project != nil && *e.Project == project {
				held = true
			}
		}
		if !held {
			p := project
			list = append(list, entry{h.tab, &p})
		}
	}
	frame, _ := json.Marshal(map[string]any{"type": "projects", "tabs": list})
	for _, st := range r.users[user] {
		if st.send != nil {
			_ = st.send(frame)
		}
	}
}

// projectOf is the tab's project right now.
func (r *Registry) projectOf(user uuid.UUID, tab string) (project *uuid.UUID, exists bool, err error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	st := r.tab(user, tab)
	if st == nil {
		return nil, false, nil
	}
	if st.switched != nil {
		return st.project, true, errSwitching
	}
	return st.project, true, nil
}

// call sends one tool call to a tab, which must still hold this project, and waits.
func (r *Registry) call(ctx context.Context, user uuid.UUID, tab string, project uuid.UUID, name string, args json.RawMessage) (json.RawMessage, error) {
	r.mu.Lock()
	st := r.tab(user, tab)
	if st == nil {
		r.mu.Unlock()
		return nil, errClosed
	}
	if st.switched != nil {
		r.mu.Unlock()
		return nil, errSwitching
	}
	if st.project == nil || *st.project != project || st.send == nil {
		r.mu.Unlock()
		return nil, errNeedOpen
	}
	r.nextID++
	id := r.nextID
	call := &pendingCall{done: make(chan answer, 1)}
	st.calls[id] = call
	frame, err := json.Marshal(map[string]any{"type": "call", "id": id, "name": name, "args": args, "project": project})
	if err == nil {
		err = st.send(frame)
	}
	if err != nil {
		delete(st.calls, id)
		r.mu.Unlock()
		return nil, errClosed
	}
	r.mu.Unlock()
	select {
	case got := <-call.done:
		return got.data, got.err
	case <-ctx.Done():
		r.mu.Lock()
		delete(st.calls, id)
		r.mu.Unlock()
		return nil, errTimeout
	}
}

// result takes an answer, only from the connection the call went to.
func (r *Registry) result(user uuid.UUID, tab string, conn uint64, id uint64, data json.RawMessage) {
	r.mu.Lock()
	defer r.mu.Unlock()
	st := r.tab(user, tab)
	if st == nil || st.conn != conn {
		return
	}
	if call := st.calls[id]; call != nil {
		delete(st.calls, id)
		call.done <- answer{data: data}
	}
}
