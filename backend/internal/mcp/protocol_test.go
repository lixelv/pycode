package mcp

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
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
