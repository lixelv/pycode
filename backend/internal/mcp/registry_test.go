package mcp

import (
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
)

func noSend([]byte) error { return nil }

func TestOpenTimeoutIs60Seconds(t *testing.T) {
	if OpenTimeout != 60*time.Second {
		t.Fatalf("OpenTimeout = %v", OpenTimeout)
	}
}

// At most one tab per project, under -race.
func TestClaimRace(t *testing.T) {
	reg := NewRegistry()
	user := uuid.New()
	project := uuid.New()
	const n = 100
	var (
		wg      sync.WaitGroup
		start   = make(chan struct{})
		mu      sync.Mutex
		winners []string
		holders = map[string]bool{}
	)
	for i := range n {
		tab := fmt.Sprintf("tab-%d", i)
		reg.Attach(user, tab, noSend)
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			ok, holder := reg.Claim(user, tab, project)
			mu.Lock()
			defer mu.Unlock()
			if ok {
				winners = append(winners, tab)
			} else {
				holders[holder] = true
			}
		}()
	}
	close(start)
	wg.Wait()
	if len(winners) != 1 {
		t.Fatalf("%d winners: %v", len(winners), winners)
	}
	if len(holders) != 1 || !holders[winners[0]] {
		t.Fatalf("losers should name the winner %s: %v", winners[0], holders)
	}
	held := 0
	for _, tab := range reg.Tabs(user) {
		if tab.Project != nil && *tab.Project == project {
			held++
		}
	}
	if held != 1 {
		t.Fatalf("Tabs shows %d holders", held)
	}
}

func TestReleaseFreesTheProject(t *testing.T) {
	reg := NewRegistry()
	user := uuid.New()
	project := uuid.New()
	reg.Attach(user, "a", noSend)
	reg.Attach(user, "b", noSend)
	if ok, _ := reg.Claim(user, "a", project); !ok {
		t.Fatal("first claim")
	}
	if ok, holder := reg.Claim(user, "b", project); ok || holder != "a" {
		t.Fatalf("second claim: %v %q", ok, holder)
	}
	reg.Release(user, "a")
	if ok, _ := reg.Claim(user, "b", project); !ok {
		t.Fatal("a released project should be free")
	}
}

func TestDetachFreesTheProjectButAnOldConnectionDoesNotDetachANewOne(t *testing.T) {
	reg := NewRegistry()
	user := uuid.New()
	project := uuid.New()
	old := reg.Attach(user, "a", noSend)
	reg.Attach(user, "a", noSend) // the reload's new connection
	if ok, _ := reg.Claim(user, "a", project); !ok {
		t.Fatal("claim")
	}
	old() // the old socket's close arrives late
	if tabs := reg.Tabs(user); len(tabs) != 1 || tabs[0].Project == nil {
		t.Fatalf("the late close took the new connection: %+v", tabs)
	}
	reg.Attach(user, "b", noSend)
	if ok, holder := reg.Claim(user, "b", project); ok || holder != "a" {
		t.Fatalf("b should still be refused: %v %q", ok, holder)
	}
}

func TestOtherUserTabsInvisible(t *testing.T) {
	reg := NewRegistry()
	alice, bob := uuid.New(), uuid.New()
	project := uuid.New()
	reg.Attach(alice, "same-id", noSend)
	if ok, _ := reg.Claim(alice, "same-id", project); !ok {
		t.Fatal("claim")
	}
	if tabs := reg.Tabs(bob); len(tabs) != 0 {
		t.Fatalf("bob sees %+v", tabs)
	}
	// The same tab id of another user is another tab, and does not push the first out.
	reg.Attach(bob, "same-id", noSend)
	if tabs := reg.Tabs(alice); len(tabs) != 1 || tabs[0].Project == nil {
		t.Fatalf("alice's tab: %+v", tabs)
	}
	if tabs := reg.Tabs(bob); len(tabs) != 1 || tabs[0].Project != nil {
		t.Fatalf("bob's tab: %+v", tabs)
	}
}
