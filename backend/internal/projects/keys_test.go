package projects

import (
	"strings"
	"testing"
	"time"
)

const (
	sha = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	// base64url of a tournament id.
	tid = "0LrQvtC90YLQtdGB0YIgMQ"
)

var (
	owner    = Actor{Owner: true}
	saver    = Actor{Owner: true, Saver: true}
	stranger = Actor{}
	reader   = Actor{Public: true}
	ownerPub = Actor{Owner: true, Public: true, Saver: true}
	forged   = Actor{Saver: true, Public: true} // says saver, but is not the owner

	publicKeys = []string{
		"public/structure.ybin.gz",
		"public/board.ybin.gz",
		"public/f/abcDEF_012-x.ybin.gz",
		"public/b/" + sha + ".gz",
	}
	hiddenKeys = []string{
		"hidden/manifest.json.gz",
		"hidden/f/abc.ybin.gz",
		"hidden/b/" + sha + ".gz",
	}
	sealedKeys = []string{
		"sealed/manifest.json.gz",
		"sealed/f/abc.ybin.gz",
		"sealed/b/" + sha + ".gz",
	}
	privateKeys = []string{
		"private/structure.ybin.gz",
		"private/f/abc.ybin.gz",
		"private/b/" + sha + ".gz",
		"private/t/" + tid + ".ybin.gz",
	}
)

func every(groups ...[]string) []string {
	var out []string
	for _, g := range groups {
		out = append(out, g...)
	}
	return out
}

func TestSpecValues(t *testing.T) {
	if PresignTTL != 5*time.Minute {
		t.Errorf("PresignTTL = %v, want 5 minutes", PresignTTL)
	}
	if SweepDelay != 6*time.Minute {
		t.Errorf("SweepDelay = %v, want 6 minutes", SweepDelay)
	}
	if MaxPresignOps != 100 {
		t.Errorf("MaxPresignOps = %d, want 100", MaxPresignOps)
	}
	if ProjectLimit != 64<<20 {
		t.Errorf("ProjectLimit = %d, want 64 MB", ProjectLimit)
	}
	if UserLimit != 1<<30 {
		t.Errorf("UserLimit = %d, want 1 GB", UserLimit)
	}
}

func TestOwnerReadsWholeProject(t *testing.T) {
	for _, key := range every(publicKeys, hiddenKeys, sealedKeys, privateKeys) {
		for _, a := range []Actor{owner, saver, ownerPub} {
			if !Allowed(Op("get"), key, a) {
				t.Errorf("owner %+v cannot read %s", a, key)
			}
		}
	}
}

func TestSaverWritesEverythingButSealed(t *testing.T) {
	for _, key := range every(publicKeys, hiddenKeys, privateKeys) {
		for _, op := range []Op{"put", "delete"} {
			if !Allowed(op, key, saver) {
				t.Errorf("saver cannot %s %s", op, key)
			}
			if Allowed(op, key, owner) {
				t.Errorf("an owner's tab that is not the saver can %s %s", op, key)
			}
		}
	}
}

func TestSealedWriteDeniedToOwner(t *testing.T) {
	for _, key := range sealedKeys {
		for _, op := range []Op{"put", "delete"} {
			for _, a := range []Actor{owner, saver, ownerPub} {
				if Allowed(op, key, a) {
					t.Errorf("%+v can %s %s", a, op, key)
				}
			}
		}
	}
}

func TestPublicPrefixOnlyForStrangers(t *testing.T) {
	for _, key := range publicKeys {
		if !Allowed(Op("get"), key, reader) {
			t.Errorf("stranger cannot read %s of a public project", key)
		}
		if Allowed(Op("get"), key, stranger) {
			t.Errorf("stranger reads %s of a private project", key)
		}
	}
	for _, key := range every(hiddenKeys, sealedKeys, privateKeys) {
		if Allowed(Op("get"), key, reader) {
			t.Errorf("stranger reads %s of a public project", key)
		}
		if Allowed(Op("get"), key, stranger) {
			t.Errorf("stranger reads %s of a private project", key)
		}
	}
}

func TestStrangersNeverWrite(t *testing.T) {
	for _, key := range every(publicKeys, hiddenKeys, sealedKeys, privateKeys) {
		for _, op := range []Op{"put", "delete"} {
			for _, a := range []Actor{stranger, reader, forged} {
				if Allowed(op, key, a) {
					t.Errorf("%+v can %s %s", a, op, key)
				}
			}
		}
	}
}

func TestUnknownOpRefused(t *testing.T) {
	for _, op := range []Op{"", "GET", "list", "copy", "post"} {
		if Allowed(op, publicKeys[0], ownerPub) {
			t.Errorf("op %q allowed", op)
		}
	}
}

func TestTraversalRejected(t *testing.T) {
	for _, key := range []string{
		"public/../private/structure.ybin.gz",
		"../public/structure.ybin.gz",
		"public/f/../../private/f/abc.ybin.gz",
		"public/f/..ybin.gz",
		"public/f/...ybin.gz",
		"public/f/..%2f..%2fprivate.ybin.gz",
		"public/f/%2e%2e.ybin.gz",
		"public/f/a/b.ybin.gz",
		"public/f/a\\b.ybin.gz",
		"public/f/a\n.ybin.gz",
		"public/f/a b.ybin.gz",
		"public/f/a.b.ybin.gz",
		"./public/structure.ybin.gz",
		"/public/structure.ybin.gz",
		"public//structure.ybin.gz",
		"public/structure.ybin.gz/",
		"public/structure.ybin.gz/x",
		"public/structure.ybin.gz\x00",
	} {
		for _, a := range []Actor{ownerPub, reader, saver} {
			for _, op := range []Op{"get", "put", "delete"} {
				if Allowed(op, key, a) {
					t.Errorf("%s of %q allowed to %+v", op, key, a)
				}
			}
		}
	}
}

func TestOnlyTheListedKeyFormsExist(t *testing.T) {
	for _, key := range []string{
		"",
		"public",
		"public/",
		"public/f/",
		"public/b/",
		"public/other.gz",
		"public/manifest.json.gz", // a manifest is hidden/ and sealed/ only
		"public/t/" + tid + ".ybin.gz",
		"hidden/structure.ybin.gz",
		"hidden/board.ybin.gz",
		"hidden/t/" + tid + ".ybin.gz",
		"sealed/structure.ybin.gz",
		"sealed/board.ybin.gz",
		"private/board.ybin.gz",
		"private/manifest.json.gz",
		"runtime.ybin.gz",
		"public/runtime.ybin.gz", // runtime is not stored
		"private/runtime.ybin.gz",
		"other/structure.ybin.gz",
		"projects/0191d8e0-0000-7000-8000-000000000000/public/structure.ybin.gz", // always built by the server
		"public/f/abc.gz",
		"public/f/abc.ybin",
		"public/f/" + strings.Repeat("a", 65) + ".ybin.gz",
		"public/b/" + sha[:63] + ".gz",
		"public/b/" + sha + "0.gz",
		"public/b/" + strings.Repeat("z", 64) + ".gz",
		"public/b/" + sha + ".ybin.gz",
		"private/t/a+b.ybin.gz", // not base64url
		"private/t/a=.ybin.gz",
	} {
		for _, op := range []Op{"get", "put", "delete"} {
			if Allowed(op, key, ownerPub) {
				t.Errorf("%s of %q allowed", op, key)
			}
		}
	}
	if !Allowed(Op("get"), "public/f/"+strings.Repeat("a", 64)+".ybin.gz", owner) {
		t.Error("a file id of 64 characters is valid")
	}
}
