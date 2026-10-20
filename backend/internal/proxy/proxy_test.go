package proxy

import (
	"net/netip"
	"testing"
)

func TestIsPublic(t *testing.T) {
	for addr, want := range map[string]bool{
		"8.8.8.8":          true,
		"142.250.74.14":    true,
		"2a00:1450::1":     true,
		"127.0.0.1":        false,
		"10.1.2.3":         false,
		"172.16.0.1":       false,
		"192.168.1.1":      false,
		"169.254.169.254":  false, // cloud metadata
		"100.64.0.1":       false,
		"0.0.0.0":          false,
		"::1":              false,
		"fd00::1":          false,
		"fe80::1":          false,
		"::ffff:127.0.0.1": false,
		"::ffff:10.0.0.1":  false,
		"224.0.0.1":        false,
		"255.255.255.255":  false,
	} {
		if got := isPublic(netip.MustParseAddr(addr)); got != want {
			t.Errorf("isPublic(%s) = %v, want %v", addr, got, want)
		}
	}
}

func TestAllowCannotOpenLoopback(t *testing.T) {
	allow := []netip.Prefix{netip.MustParsePrefix("198.18.0.0/15"), netip.MustParsePrefix("127.0.0.0/8")}
	if !isPublicWith(netip.MustParseAddr("198.18.0.25"), allow) {
		t.Error("allowed fake-IP range should pass")
	}
	if isPublicWith(netip.MustParseAddr("127.0.0.1"), allow) {
		t.Error("loopback must stay blocked even if listed")
	}
}
