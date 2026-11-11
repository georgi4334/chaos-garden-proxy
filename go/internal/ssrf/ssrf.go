// Package ssrf stops the proxy from being pointed at internal addresses.
//
// Users type in the target URLs, so without these checks the proxy could reach
// localhost, the internal network or a cloud metadata service. The check runs
// on the IP address actually being connected to (net.Dialer.Control), so a
// public hostname that resolves to 127.0.0.1 is refused too.
package ssrf

import (
	"errors"
	"net"
	"net/netip"
	"net/url"
	"syscall"
)

// ErrBlocked is returned when a target address is not allowed.
var ErrBlocked = errors.New("target address is not allowed")

var extraBlocked = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),     // "this" network
	netip.MustParsePrefix("100.64.0.0/10"), // carrier-grade NAT
	netip.MustParsePrefix("192.0.0.0/24"),  // IETF protocol assignments
	netip.MustParsePrefix("198.18.0.0/15"), // benchmarking
	netip.MustParsePrefix("240.0.0.0/4"),   // reserved, includes broadcast
}

// IsBlocked reports whether connecting to ip must be refused.
func IsBlocked(ip netip.Addr) bool {
	ip = ip.Unmap() // judge ::ffff:a.b.c.d as a.b.c.d
	if !ip.IsValid() || ip.IsUnspecified() || ip.IsLoopback() || ip.IsPrivate() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast() || ip.IsInterfaceLocalMulticast() {
		return true // IsLinkLocalUnicast covers 169.254.169.254, the cloud metadata address
	}
	for _, p := range extraBlocked {
		if p.Contains(ip) {
			return true
		}
	}
	return false
}

// CheckURL rejects non-http(s) URLs. Hostnames are checked at connect time.
func CheckURL(u *url.URL) error {
	if u.Scheme != "http" && u.Scheme != "https" {
		return errors.New("only http and https targets are allowed")
	}
	return nil
}

// DialControl is a net.Dialer Control function that refuses blocked addresses.
func DialControl(_, address string, _ syscall.RawConn) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return err
	}
	ip, err := netip.ParseAddr(host)
	if err != nil || IsBlocked(ip) {
		return ErrBlocked
	}
	return nil
}
