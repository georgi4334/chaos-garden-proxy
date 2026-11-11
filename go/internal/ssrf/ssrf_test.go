package ssrf

import (
	"errors"
	"net/netip"
	"net/url"
	"testing"
)

func TestIsBlocked(t *testing.T) {
	blocked := []string{"127.0.0.1", "127.8.8.8", "0.0.0.0", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1",
		"169.254.169.254", "100.64.0.1", "224.0.0.1", "255.255.255.255", "::1", "::", "fc00::1", "fd12:3456::1", "fe80::1",
		"ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe"}
	for _, s := range blocked {
		if !IsBlocked(netip.MustParseAddr(s)) {
			t.Errorf("%s should be blocked", s)
		}
	}
	for _, s := range []string{"8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "93.184.216.34", "2606:4700:4700::1111"} {
		if IsBlocked(netip.MustParseAddr(s)) {
			t.Errorf("%s should be allowed", s)
		}
	}
}

func TestCheckURLAndDialControl(t *testing.T) {
	for _, raw := range []string{"file:///etc/passwd", "ftp://example.com"} {
		u, _ := url.Parse(raw)
		if CheckURL(u) == nil {
			t.Errorf("%s should be rejected", raw)
		}
	}
	u, _ := url.Parse("https://api.example.com")
	if CheckURL(u) != nil {
		t.Error("https should be allowed")
	}
	if err := DialControl("tcp", "127.0.0.1:80", nil); !errors.Is(err, ErrBlocked) {
		t.Errorf("dialing loopback should be blocked, got %v", err)
	}
	if err := DialControl("tcp", "[::ffff:169.254.169.254]:80", nil); !errors.Is(err, ErrBlocked) {
		t.Errorf("dialing mapped metadata address should be blocked, got %v", err)
	}
	if err := DialControl("tcp", "8.8.8.8:443", nil); err != nil {
		t.Errorf("public address should be allowed, got %v", err)
	}
}
