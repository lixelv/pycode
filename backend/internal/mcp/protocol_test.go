package mcp

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestToolsListIsValidJSON(t *testing.T) {
	var tools []struct {
		Name        string         `json:"name"`
		Description string         `json:"description"`
		InputSchema map[string]any `json:"inputSchema"`
	}
	if err := json.Unmarshal(mcpToolsJSON, &tools); err != nil {
		t.Fatal(err)
	}
	if len(tools) == 0 {
		t.Fatal("no tools")
	}
	for _, tool := range tools {
		if tool.Name == "" || tool.Description == "" || tool.InputSchema["type"] != "object" {
			t.Fatalf("bad tool: %+v", tool)
		}
	}
}

// The guides need no tab, project or arguments, and come back as plain text.
func TestGuidesAreText(t *testing.T) {
	for name, word := range map[string]string{"polycode_guide": "open_project", "polycode_tests_guide": "t.tournament("} {
		result, err := serverTools[name](nil, context.Background(), sessionKey{}, nil)
		if err != nil {
			t.Fatal(err)
		}
		content := result.(map[string]any)["content"].([]map[string]string)
		if len(content) != 1 || content[0]["type"] != "text" || !strings.Contains(content[0]["text"], word) {
			t.Errorf("%s: %+v", name, content)
		}
	}
}

func TestOriginAllowed(t *testing.T) {
	req := func(origin string) *http.Request {
		r := httptest.NewRequest("POST", "http://polycode.example/mcp", nil)
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		return r
	}
	if !originAllowed(req(""), nil) || !originAllowed(req("https://polycode.example"), nil) {
		t.Fatal("an agent or our own page should pass")
	}
	if originAllowed(req("https://evil.example"), nil) {
		t.Fatal("another site should not")
	}
	if !originAllowed(req("https://localhost:5173"), []string{"localhost:*"}) {
		t.Fatal("a configured pattern should pass")
	}
}
