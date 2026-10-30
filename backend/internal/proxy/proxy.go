// Package proxy lets the in-browser Python reach the internet: the browser
// cannot call most sites directly (CORS), so requests go through here.
//
// Only public addresses are reachable. The check runs on the resolved IP of
// every connection (redirects included), which also defeats DNS rebinding.
package proxy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/lixelv/polycode/backend/internal/identity"
	"github.com/lixelv/polycode/backend/internal/ratelimit"
)

const (
	maxRequestBody  = 10 << 20
	maxResponseBody = 50 << 20
	maxRedirects    = 5
)

var errBlocked = errors.New("local and private addresses are not allowed")

// Handler serves /api/proxy?url=<absolute http(s) URL>.
type Handler struct {
	client  *http.Client
	limiter *ratelimit.Limiter
	allow   []netip.Prefix
}

// New builds the proxy. allow lists extra CIDRs to treat as public; it is
// meant for VPNs with "fake IP" DNS (198.18.0.0/15) on a developer machine.
// Loopback, private and link-local ranges can never be allowed.
func New(limiter *ratelimit.Limiter, allow []netip.Prefix) *Handler {
	isPublic := func(ip netip.Addr) bool { return isPublicWith(ip, allow) }
	dialer := &net.Dialer{
		Timeout:   10 * time.Second,
		KeepAlive: 30 * time.Second,
		Control: func(_, address string, _ syscall.RawConn) error {
			host, _, err := net.SplitHostPort(address)
			if err != nil {
				return err
			}
			ip, err := netip.ParseAddr(host)
			if err != nil || !isPublic(ip) {
				return errBlocked
			}
			return nil
		},
	}
	transport := &http.Transport{
		Proxy:                 nil, // never through an environment proxy
		DialContext:           dialer.DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          100,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 20 * time.Second,
	}
	return &Handler{
		limiter: limiter,
		allow:   allow,
		client: &http.Client{
			Transport: transport,
			Timeout:   60 * time.Second,
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				if len(via) >= maxRedirects {
					return fmt.Errorf("stopped after %d redirects", maxRedirects)
				}
				if req.URL.Scheme != "http" && req.URL.Scheme != "https" {
					return fmt.Errorf("redirect to unsupported scheme %q", req.URL.Scheme)
				}
				return nil
			},
		},
	}
}

func isPublic(ip netip.Addr) bool { return isPublicWith(ip, nil) }

// isPublicWith reports whether ip is a globally routable unicast address
// (or inside one of the explicitly allowed special-purpose prefixes).
func isPublicWith(ip netip.Addr, allow []netip.Prefix) bool {
	ip = ip.Unmap()
	if !ip.IsValid() || ip.IsLoopback() || ip.IsPrivate() || ip.IsUnspecified() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsInterfaceLocalMulticast() ||
		ip.IsMulticast() {
		return false
	}
	for _, p := range allow {
		if p.Contains(ip) {
			return true
		}
	}
	for _, p := range blockedPrefixes {
		if p.Contains(ip) {
			return false
		}
	}
	return true
}

var blockedPrefixes = func() []netip.Prefix {
	var out []netip.Prefix
	for _, s := range []string{
		"0.0.0.0/8",       // "this network"
		"100.64.0.0/10",   // carrier-grade NAT
		"192.0.0.0/24",    // IETF protocol assignments
		"192.0.2.0/24",    // documentation
		"198.18.0.0/15",   // benchmarking
		"198.51.100.0/24", // documentation
		"203.0.113.0/24",  // documentation
		"240.0.0.0/4",     // reserved, broadcast
		"64:ff9b::/96",    // NAT64 (could map to private IPv4)
		"64:ff9b:1::/48",  // local-use NAT64
		"100::/64",        // discard
		"2001:db8::/32",   // documentation
		"2002::/16",       // 6to4 (embeds IPv4)
		"fc00::/7",        // unique local
		"fec0::/10",       // site local (deprecated)
	} {
		out = append(out, netip.MustParsePrefix(s))
	}
	return out
}()

// Request headers that must not leave for the target site.
var dropRequest = map[string]bool{
	"Cookie": true, "Host": true, "Origin": true, "Referer": true, "Connection": true,
	"Proxy-Connection": true, "Keep-Alive": true, "Te": true, "Trailer": true, "Upgrade": true,
	"X-Forwarded-For": true, "X-Forwarded-Proto": true, "X-Forwarded-Host": true, "X-Real-Ip": true,
	"Forwarded": true, "Accept-Encoding": true, "Content-Length": true,
}

// Response headers that would affect our own origin.
var dropResponse = map[string]bool{
	"Set-Cookie": true, "Content-Security-Policy": true, "Content-Security-Policy-Report-Only": true,
	"Strict-Transport-Security": true, "Access-Control-Allow-Origin": true, "Access-Control-Allow-Credentials": true,
	"Access-Control-Allow-Headers": true, "Access-Control-Allow-Methods": true, "Access-Control-Expose-Headers": true,
	"Cross-Origin-Opener-Policy": true, "Cross-Origin-Embedder-Policy": true, "Cross-Origin-Resource-Policy": true,
	"Connection": true, "Keep-Alive": true, "Transfer-Encoding": true, "Content-Length": true,
	"Content-Encoding": true, "Alt-Svc": true, "Clear-Site-Data": true, "Refresh": true, "Link": true,
}

func (h *Handler) isPublic(ip netip.Addr) bool { return isPublicWith(ip, h.allow) }

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	user := identity.FromContext(r.Context())
	if ok, wait := h.limiter.Allow(user.String()); !ok {
		w.Header().Set("Retry-After", strconv.Itoa(int(wait.Seconds())+1))
		fail(w, http.StatusTooManyRequests, "Rate limit: at most 256 network requests per minute.")
		return
	}

	target, err := url.Parse(r.URL.Query().Get("url"))
	if err != nil || (target.Scheme != "http" && target.Scheme != "https") || target.Host == "" {
		fail(w, http.StatusBadRequest, "Pass an absolute http(s) URL in ?url=")
		return
	}
	// Literal IPs and obviously local names fail fast; everything else is
	// checked on the resolved address when connecting.
	if ip, err := netip.ParseAddr(strings.Trim(target.Hostname(), "[]")); err == nil && !h.isPublic(ip) {
		fail(w, http.StatusForbidden, errBlocked.Error())
		return
	}
	if h := strings.ToLower(target.Hostname()); h == "localhost" || strings.HasSuffix(h, ".localhost") || strings.HasSuffix(h, ".local") || strings.HasSuffix(h, ".internal") {
		fail(w, http.StatusForbidden, errBlocked.Error())
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	out, err := http.NewRequestWithContext(ctx, r.Method, target.String(), http.MaxBytesReader(w, r.Body, maxRequestBody))
	if err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	out.ContentLength = r.ContentLength
	for k, vs := range r.Header {
		if dropRequest[http.CanonicalHeaderKey(k)] || strings.HasPrefix(strings.ToLower(k), "sec-") {
			continue
		}
		for _, v := range vs {
			out.Header.Add(k, v)
		}
	}
	if out.Header.Get("User-Agent") == "" {
		out.Header.Set("User-Agent", "polycode-proxy/1.0")
	}

	resp, err := h.client.Do(out)
	if err != nil {
		status := http.StatusBadGateway
		msg := err.Error()
		if errors.Is(err, errBlocked) {
			status, msg = http.StatusForbidden, errBlocked.Error()
		} else if errors.Is(err, context.DeadlineExceeded) {
			status, msg = http.StatusGatewayTimeout, "The site took too long to answer."
		}
		fail(w, status, msg)
		return
	}
	defer resp.Body.Close()

	for k, vs := range resp.Header {
		if dropResponse[http.CanonicalHeaderKey(k)] {
			continue
		}
		for _, v := range vs {
			w.Header().Add(k, v)
		}
	}
	w.Header().Set("X-Proxy-Final-Url", resp.Request.URL.String())
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, io.LimitReader(resp.Body, maxResponseBody))
}

func fail(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Proxy-Error", "1")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": message})
}
