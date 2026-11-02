package storage

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// Integration tests against a real MinIO. Run with, for example:
//
//	S3_TEST_ENDPOINT=localhost:9000 S3_TEST_ACCESS_KEY=… S3_TEST_SECRET_KEY=… S3_TEST_BUCKET=… go test ./internal/storage/
func testS3(t *testing.T) (*S3, string, string) {
	t.Helper()
	endpoint := os.Getenv("S3_TEST_ENDPOINT")
	if endpoint == "" {
		t.Skip("S3_TEST_ENDPOINT is not set")
	}
	endpoint = strings.TrimPrefix(endpoint, "http://")
	// S3_TEST_SSL=true for a real provider (R2 answers only HTTPS).
	ssl := os.Getenv("S3_TEST_SSL") == "true"
	scheme := "http://"
	if ssl {
		scheme = "https://"
	}
	region := os.Getenv("S3_TEST_REGION")
	if region == "" {
		region = "us-east-1"
	}
	bucket := os.Getenv("S3_TEST_BUCKET")
	s, err := New(context.Background(), Config{
		Endpoint:       endpoint,
		PublicEndpoint: endpoint,
		Bucket:         bucket,
		AccessKey:      os.Getenv("S3_TEST_ACCESS_KEY"),
		SecretKey:      os.Getenv("S3_TEST_SECRET_KEY"),
		Region:         region,
		UseSSL:         ssl,
	})
	if err != nil {
		t.Fatal(err)
	}
	prefix := "storage-test/" + uuid.NewString() + "/"
	t.Cleanup(func() { _ = s.DeletePrefix(context.Background(), prefix) })
	return s, scheme + endpoint + "/" + bucket, prefix
}

func send(t *testing.T, method, target, body string) (int, string) {
	t.Helper()
	req, err := http.NewRequest(method, target, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(data)
}

func keysOf(t *testing.T, s *S3, prefix string) map[string]int64 {
	t.Helper()
	objects, err := s.List(context.Background(), prefix)
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]int64{}
	for _, o := range objects {
		out[o.Key] = o.Size
	}
	return out
}

func TestAnonymousDenied(t *testing.T) {
	s, base, prefix := testS3(t)
	ctx := context.Background()
	key := prefix + "public/structure.ybin.gz"
	if err := s.WriteSmall(ctx, key, []byte("secret")); err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{"GET", "HEAD", "PUT", "DELETE"} {
		// Refused, however the provider words it (R2 says 400).
		status, body := send(t, method, base+"/"+key, "anon")
		if status < 400 || status >= 500 {
			t.Errorf("anonymous %s: got %d, want a refusal", method, status)
		}
		if strings.Contains(body, "secret") {
			t.Errorf("anonymous %s saw the object", method)
		}
	}
	data, err := s.ReadSmall(ctx, key, 100)
	if err != nil || string(data) != "secret" {
		t.Fatalf("object changed by an anonymous request: %q, %v", data, err)
	}
}

func TestListDeniedWithoutSignature(t *testing.T) {
	s, base, prefix := testS3(t)
	if err := s.WriteSmall(context.Background(), prefix+"a", []byte("x")); err != nil {
		t.Fatal(err)
	}
	for _, target := range []string{
		base,
		base + "/",
		base + "?list-type=2",
		base + "?list-type=2&prefix=" + url.QueryEscape(prefix),
		base + "?delimiter=/",
	} {
		status, body := send(t, "GET", target, "")
		if status < 400 || status >= 500 {
			t.Errorf("GET %s: got %d, want a refusal", target, status)
		}
		if strings.Contains(body, prefix) {
			t.Errorf("GET %s listed the keys", target)
		}
	}
}

func TestPutWrongSizeRejected(t *testing.T) {
	s, _, prefix := testS3(t)
	ctx := context.Background()
	key := prefix + "sized"
	u, err := s.PresignPut(ctx, key, 10, 5*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	for _, body := range []string{"123456789", "12345678901", ""} {
		if status, _ := send(t, "PUT", u, body); status < 400 {
			t.Errorf("PUT of %d bytes under a 10-byte signature: got %d", len(body), status)
		}
		if _, there := keysOf(t, s, prefix)[key]; there {
			t.Fatalf("a PUT of %d bytes left an object", len(body))
		}
	}
	if status, _ := send(t, "PUT", u, "1234567890"); status != http.StatusOK {
		t.Fatalf("PUT of the signed size: got %d", status)
	}
	if size := keysOf(t, s, prefix)[key]; size != 10 {
		t.Fatalf("stored size %d, want 10", size)
	}
}

func TestExpiredURLRejected(t *testing.T) {
	s, _, prefix := testS3(t)
	ctx := context.Background()
	key := prefix + "expiring"
	if err := s.WriteSmall(ctx, key, []byte("value")); err != nil {
		t.Fatal(err)
	}
	get, err := s.PresignGet(ctx, key, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	put, err := s.PresignPut(ctx, key, 3, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	del, err := s.PresignDelete(ctx, key, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if status, body := send(t, "GET", get, ""); status != http.StatusOK || body != "value" {
		t.Fatalf("fresh URL: %d %q", status, body)
	}
	time.Sleep(2500 * time.Millisecond)
	if status, _ := send(t, "GET", get, ""); status != http.StatusForbidden {
		t.Errorf("expired GET: got %d, want 403", status)
	}
	if status, _ := send(t, "PUT", put, "abc"); status != http.StatusForbidden {
		t.Errorf("expired PUT: got %d, want 403", status)
	}
	if status, _ := send(t, "DELETE", del, ""); status != http.StatusForbidden {
		t.Errorf("expired DELETE: got %d, want 403", status)
	}
	data, err := s.ReadSmall(ctx, key, 100)
	if err != nil || string(data) != "value" {
		t.Fatalf("object changed through expired URLs: %q, %v", data, err)
	}
}

func TestPresignedKeyOnlyOpensThatKey(t *testing.T) {
	s, _, prefix := testS3(t)
	ctx := context.Background()
	a := prefix + "projects/aaa/public/structure.ybin.gz"
	b := prefix + "projects/bbb/public/structure.ybin.gz"
	if err := s.WriteSmall(ctx, a, []byte("from A")); err != nil {
		t.Fatal(err)
	}
	if err := s.WriteSmall(ctx, b, []byte("from B")); err != nil {
		t.Fatal(err)
	}
	get, err := s.PresignGet(ctx, a, 5*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if status, body := send(t, "GET", get, ""); status != http.StatusOK || body != "from A" {
		t.Fatalf("own key: %d %q", status, body)
	}
	other := strings.Replace(get, "/projects/aaa/", "/projects/bbb/", 1)
	if other == get {
		t.Fatalf("URL does not hold the key: %s", get)
	}
	if status, body := send(t, "GET", other, ""); status != http.StatusForbidden || strings.Contains(body, "from B") {
		t.Errorf("URL of A on the key of B: %d %q", status, body)
	}
	// The same signature does not list, write or delete.
	parsed, _ := url.Parse(get)
	listing := *parsed
	listing.Path = parsed.Path[:strings.Index(parsed.Path, "/projects/aaa/")]
	if status, body := send(t, "GET", listing.String(), ""); status != http.StatusForbidden || strings.Contains(body, "bbb") {
		t.Errorf("URL of a key used on its folder: %d %q", status, body)
	}
	if status, _ := send(t, "PUT", get, "x"); status != http.StatusForbidden {
		t.Errorf("GET URL used for PUT: got %d, want 403", status)
	}
	if status, _ := send(t, "DELETE", get, ""); status != http.StatusForbidden {
		t.Errorf("GET URL used for DELETE: got %d, want 403", status)
	}
}

// S3_PUBLIC_ENDPOINT goes into the signature, and with the region set presigning
// needs no network: this endpoint does not exist.
func TestPresignUsesThePublicEndpointWithoutNetwork(t *testing.T) {
	ctx := context.Background()
	s, err := New(ctx, Config{
		Endpoint:       "s3.invalid:9000",
		PublicEndpoint: "files.invalid:9443",
		Bucket:         "polycode",
		AccessKey:      "key",
		SecretKey:      "secret-secret",
		Region:         "us-east-1",
		UseSSL:         true,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	raw, err := s.PresignGet(ctx, "projects/x/public/board.ybin.gz", 5*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	if u.Scheme != "https" || u.Host != "files.invalid:9443" {
		t.Fatalf("URL goes to %s://%s", u.Scheme, u.Host)
	}
	if got := u.Query().Get("X-Amz-Expires"); got != fmt.Sprint(int((5 * time.Minute).Seconds())) {
		t.Fatalf("X-Amz-Expires = %q, want 300", got)
	}
	put, err := s.PresignPut(ctx, "projects/x/public/board.ybin.gz", 123, 5*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.ToLower(put), "content-length") {
		t.Fatalf("Content-Length is not among the signed headers: %s", put)
	}
}

func TestListCopyReadAndDeletePrefix(t *testing.T) {
	s, _, prefix := testS3(t)
	ctx := context.Background()
	if err := s.WriteSmall(ctx, prefix+"p1/a", []byte("hello")); err != nil {
		t.Fatal(err)
	}
	// A prefix is a folder: p1/ does not take p10/.
	if err := s.WriteSmall(ctx, prefix+"p10/keep", []byte("k")); err != nil {
		t.Fatal(err)
	}
	if err := s.Copy(ctx, prefix+"p1/a", prefix+"p2/b"); err != nil {
		t.Fatal(err)
	}
	data, err := s.ReadSmall(ctx, prefix+"p2/b", 100)
	if err != nil || string(data) != "hello" {
		t.Fatalf("copy: %q, %v", data, err)
	}
	if _, err := s.ReadSmall(ctx, prefix+"p2/b", 4); err == nil {
		t.Fatal("ReadSmall should refuse an object over its limit")
	}
	if _, err := s.ReadSmall(ctx, prefix+"missing", 100); err == nil {
		t.Fatal("ReadSmall of a missing object should fail")
	}
	got := keysOf(t, s, prefix)
	if len(got) != 3 || got[prefix+"p1/a"] != 5 || got[prefix+"p2/b"] != 5 || got[prefix+"p10/keep"] != 1 {
		t.Fatalf("list: %v", got)
	}
	if err := s.DeletePrefix(ctx, prefix+"p1/"); err != nil {
		t.Fatal(err)
	}
	got = keysOf(t, s, prefix)
	if _, there := got[prefix+"p1/a"]; there {
		t.Fatal("DeletePrefix left the object")
	}
	if _, there := got[prefix+"p10/keep"]; !there {
		t.Fatal("DeletePrefix took a neighbour with the same beginning")
	}
}

// ListObjectsV2 and DeleteObjects both work in pages of 1000.
func TestDeletePrefixPastOnePage(t *testing.T) {
	s, _, prefix := testS3(t)
	ctx := context.Background()
	for i := range 1005 {
		if err := s.WriteSmall(ctx, fmt.Sprintf("%smany/%04d", prefix, i), []byte{1}); err != nil {
			t.Fatal(err)
		}
	}
	if got := len(keysOf(t, s, prefix+"many/")); got != 1005 {
		t.Fatalf("list returned %d of 1005", got)
	}
	if err := s.DeletePrefix(ctx, prefix+"many/"); err != nil {
		t.Fatal(err)
	}
	if got := len(keysOf(t, s, prefix+"many/")); got != 0 {
		t.Fatalf("%d objects left", got)
	}
}
