package mcp

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"

	"github.com/lixelv/polycode/backend/internal/projects"
)

//go:embed guide.md
var guide string

//go:embed tests_guide.md
var testsGuide string

// serverTools need no browser, except open_project, which waits for one.
var serverTools = map[string]func(*Server, context.Context, sessionKey, json.RawMessage) (any, error){
	"polycode_guide":       docTool(guide),
	"polycode_tests_guide": docTool(testsGuide),
	"list_tabs":            (*Server).listTabs,
	"list_projects":        (*Server).listProjects,
	"create_project":       (*Server).createProject,
	"delete_project":       (*Server).deleteProject,
	"open_project":         (*Server).openProject,
}

// ServerToolNames is what a tab never gets.
func ServerToolNames() []string {
	out := make([]string, 0, len(serverTools))
	for name := range serverTools {
		out = append(out, name)
	}
	return out
}

// docTool answers with a fixed Markdown text.
func docTool(text string) func(*Server, context.Context, sessionKey, json.RawMessage) (any, error) {
	return func(*Server, context.Context, sessionKey, json.RawMessage) (any, error) {
		return map[string]any{"content": []map[string]string{{"type": "text", "text": text}}}, nil
	}
}

func stringArg(args json.RawMessage, name string) string {
	var values map[string]any
	_ = json.Unmarshal(args, &values)
	value, _ := values[name].(string)
	return value
}

// resolve finds a project of the user by id or name; several matches are an
// error naming them (a name can be another project's id).
func (s *Server) resolve(ctx context.Context, user uuid.UUID, ref string) (*projects.Project, error) {
	if ref == "" {
		return nil, errors.New("project is required: its name or id. See list_projects.")
	}
	list, err := s.cfg.Projects.List(ctx, user)
	if err != nil {
		return nil, errors.New("could not read the projects")
	}
	var found []*projects.Project
	for _, p := range list {
		if p.ID.String() == strings.ToLower(ref) || p.Name == ref {
			found = append(found, p)
		}
	}
	switch len(found) {
	case 0:
		return nil, fmt.Errorf("no project %q. See list_projects.", ref)
	case 1:
		return found[0], nil
	}
	names := make([]string, len(found))
	for i, p := range found {
		names[i] = fmt.Sprintf("%q (%s)", p.Name, p.ID)
	}
	return nil, fmt.Errorf("several projects match %q, use the id of one: %s", ref, strings.Join(names, ", "))
}

func (s *Server) listTabs(ctx context.Context, key sessionKey, _ json.RawMessage) (any, error) {
	type tabJSON struct {
		TabID   string       `json:"tab_id"`
		Project *projectName `json:"project"`
	}
	list, err := s.cfg.Projects.List(ctx, key.user)
	if err != nil {
		return nil, errors.New("could not read the projects")
	}
	names := map[uuid.UUID]string{}
	for _, p := range list {
		names[p.ID] = p.Name
	}
	tabs := []tabJSON{}
	for _, t := range s.cfg.Registry.Tabs(key.user) {
		entry := tabJSON{TabID: t.ID}
		if t.Project != nil {
			entry.Project = &projectName{*t.Project, names[*t.Project]}
		}
		tabs = append(tabs, entry)
	}
	return toolJSON(map[string]any{"tabs": tabs}), nil
}

func (s *Server) listProjects(ctx context.Context, key sessionKey, _ json.RawMessage) (any, error) {
	type projectJSON struct {
		ID    uuid.UUID `json:"id"`
		Name  string    `json:"name"`
		TabID *string   `json:"tab_id"`
	}
	list, err := s.cfg.Projects.List(ctx, key.user)
	if err != nil {
		return nil, errors.New("could not read the projects")
	}
	tabOf := map[uuid.UUID]string{}
	for _, t := range s.cfg.Registry.Tabs(key.user) {
		if t.Project != nil {
			tabOf[*t.Project] = t.ID
		}
	}
	out := make([]projectJSON, len(list))
	for i, p := range list {
		out[i] = projectJSON{ID: p.ID, Name: p.Name}
		if tab, ok := tabOf[p.ID]; ok {
			out[i].TabID = &tab
		}
	}
	return toolJSON(map[string]any{"projects": out}), nil
}

func (s *Server) createProject(ctx context.Context, key sessionKey, args json.RawMessage) (any, error) {
	name := stringArg(args, "project")
	if !projects.ValidName(name) {
		return nil, errors.New("a project's name takes 1 to 100 characters")
	}
	p, err := s.cfg.Projects.Create(ctx, key.user, name, nil, 0)
	if errors.Is(err, projects.ErrNameTaken) {
		return nil, err
	}
	if err != nil {
		return nil, errors.New("could not create the project")
	}
	return toolJSON(projectName{p.ID, p.Name}), nil
}

func (s *Server) deleteProject(ctx context.Context, key sessionKey, args json.RawMessage) (any, error) {
	p, err := s.resolve(ctx, key.user, stringArg(args, "project"))
	if err != nil {
		return nil, err
	}
	if err := s.cfg.DeleteProject(ctx, key.user, p.ID); err != nil {
		return nil, errors.New("could not delete the project")
	}
	s.cfg.Registry.ProjectGone(p.ID)
	return toolJSON(map[string]any{"deleted": projectName{p.ID, p.Name}}), nil
}

func (s *Server) openProject(ctx context.Context, key sessionKey, args json.RawMessage) (any, error) {
	tab := stringArg(args, "tab_id")
	if tab == "" {
		return nil, errors.New("tab_id is required. See list_tabs.")
	}
	p, err := s.resolve(ctx, key.user, stringArg(args, "project"))
	if err != nil {
		return nil, err
	}
	if _, err := s.cfg.Registry.open(ctx, key.user, tab, p.ID, s.cfg.OpenTimeout); err != nil {
		return nil, err
	}
	s.setCurrent(key, tab)
	return toolJSON(stampFields{tab, projectName{p.ID, p.Name}}), nil
}
