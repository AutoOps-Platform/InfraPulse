package plugin

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

type transportFunc func(*http.Request) (*http.Response, error)

func (f transportFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func assertionApp(t *testing.T) (*App, ed25519.PublicKey) {
	t.Helper()
	pub, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal("key generation failed")
	}
	origin, _ := url.Parse("http://management:3000")
	return &App{cfg: Config{ManagementURL: origin, AssertionIssuer: "test-ui", AssertionAudience: "test-management", AssertionKeyID: "test-user-key", AssertionContext: "test-instance-context", SigningKey: private}}, pub
}
func TestManagementAssertionBindsActualRawRequest(t *testing.T) {
	app, pub := assertionApp(t)
	body := []byte(`{"name":"unicode λ","os":"linux","environment":"lab"}`)
	target := "/api/v1/servers?name=a%20b&limit=20&cursor=a%2Fb%2Bc%3D"
	calls := 0
	seen := map[string]bool{}
	app.http = &http.Client{Transport: transportFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.URL.RequestURI() != target {
			t.Error("outbound target was rewritten")
		}
		raw, _ := io.ReadAll(r.Body)
		if string(raw) != string(body) {
			t.Error("outbound body was rewritten")
		}
		if r.Header.Get("Cookie") != "" || r.Header.Get("X-Grafana-Id") != "" {
			t.Error("Grafana credentials were forwarded")
		}
		compact := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		token, err := jwt.Parse(compact, func(token *jwt.Token) (any, error) { return pub, nil }, jwt.WithValidMethods([]string{"EdDSA"}), jwt.WithIssuer("test-ui"), jwt.WithAudience("test-management"), jwt.WithExpirationRequired())
		if err != nil || !token.Valid {
			t.Fatal("assertion signature invalid")
		}
		claims := token.Claims.(jwt.MapClaims)
		digest := sha256.Sum256(raw)
		if claims["m"] != r.Method || claims["t"] != r.URL.RequestURI() || claims["b"] != base64.RawURLEncoding.EncodeToString(digest[:]) {
			t.Error("request binding mismatch")
		}
		if claims["sub"] != "user:42" || claims["kind"] != "user" || claims["grafana_role"] != "Admin" || claims["ctx"] != "test-instance-context" {
			t.Error("principal binding mismatch")
		}
		nonce, _ := claims["jti"].(string)
		if !canonicalUUID.MatchString(nonce) || seen[nonce] {
			t.Error("nonce is not unique canonical UUID")
		}
		seen[nonce] = true
		issued, _ := token.Claims.GetIssuedAt()
		expiry, _ := token.Claims.GetExpirationTime()
		if issued == nil || expiry == nil || expiry.Sub(issued.Time) > 60*time.Second {
			t.Error("invalid assertion lifetime")
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"items":[],"next_cursor":null}`))}, nil
	})}
	for i := 0; i < 2; i++ {
		status, _, err := app.management(context.Background(), Identity{Subject: "user:42", Role: "Admin"}, "POST", target, body, "")
		if err != nil || status != 200 {
			t.Fatal("outbound request failed")
		}
	}
	if calls != 2 {
		t.Error("unexpected request retry/count")
	}
}
func TestManagementRouteAllowlistAndQueryBinding(t *testing.T) {
	good := "api/v1/servers?name=a%20b&limit=20&cursor=a%2Fb%2Bc%3D"
	actual, err := managementTarget("GET", good, "api/v1/servers")
	if err != nil || actual != "/"+good {
		t.Error("valid query octets were not retained")
	}
	cases := [][3]string{
		{"GET", "https://attacker.invalid/api/v1/me", "api/v1/me"},
		{"GET", "//attacker.invalid/api/v1/me", "api/v1/me"},
		{"GET", "api/v1/servers?limit=1&limit=2", "api/v1/servers"},
		{"GET", "api/v1/servers?unexpected=x", "api/v1/servers"},
		{"GET", "api/v1/servers#fragment", "api/v1/servers"},
		{"GET", "api/v1/servers/../me", "api/v1/servers/../me"},
		{"GET", "internal/v1/credentials/verify", "internal/v1/credentials/verify"},
		{"POST", "api/v1/monitoring-profiles", "api/v1/monitoring-profiles"},
		{"GET", "api/v1/me", "api/v1/servers"},
		{"GET", "api/v1/%6de", "api/v1/me"},
	}
	for _, item := range cases {
		if _, err := managementTarget(item[0], item[1], item[2]); err == nil {
			t.Errorf("unsupported resource was admitted: %s", item[2])
		}
	}
}
func TestSafeErrorExcludesUnexpectedSecretMembers(t *testing.T) {
	raw := []byte(`{"code":"secret_already_issued","message":"untrusted text","credential":{"id":"metadata","api_key":"must-not-escape","secret":"must-not-escape"},"api_key":"must-not-escape"}`)
	safe := safeError(raw)
	if strings.Contains(string(safe), "must-not-escape") || strings.Contains(string(safe), "untrusted text") {
		t.Error("unsafe response member retained")
	}
	var payload map[string]any
	if json.Unmarshal(safe, &payload) != nil || payload["code"] != "secret_already_issued" {
		t.Error("safe recovery code missing")
	}
}
func TestTrustedDestinationsRejectBrowserStyleURLs(t *testing.T) {
	for _, raw := range []string{"http://public.example.com", "https://user:pass@example.com", "https://example.com?token=x", "https://example.com/#x", "https://example.com/escape", "https://example.com/%2e%2e"} {
		if _, err := trustedURL(raw, false, true); err == nil {
			t.Error("unsafe destination accepted")
		}
	}
	if _, err := trustedURL("http://management:3000", false, false); err == nil {
		t.Error("private plaintext channel not explicitly authorized")
	}
	if _, err := trustedURL("http://management:3000", false, true); err != nil {
		t.Error("explicit current Docker channel rejected")
	}
	if _, err := trustedURL("https://gateway.example.com:8443/", false, false); err != nil {
		t.Error("valid TLS origin rejected")
	}
}
