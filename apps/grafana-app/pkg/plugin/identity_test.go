package plugin

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/config"
)

type identityRoundTripper func(*http.Request) (*http.Response, error)

func (f identityRoundTripper) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

type identityFixture struct {
	key    *ecdsa.PrivateKey
	now    time.Time
	cfg    IdentityConfig
	pc     backend.PluginContext
	mu     sync.Mutex
	calls  int
	body   string
	status int
}

func newIdentityFixture(t *testing.T) *identityFixture {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	f := &identityFixture{key: key, now: time.Date(2026, 11, 3, 0, 0, 0, 0, time.UTC), status: 200}
	f.cfg = IdentityConfig{GrafanaIssuer: "https://grafana.example/", GrafanaJWKSURL: "https://grafana.example/api/signing-keys/keys", GrafanaOrgID: 1, GrafanaNamespace: "default", AllowedAuthMethods: []string{"password"}}
	f.pc = backend.PluginContext{PluginID: "infrapulse-infrapulse-app", OrgID: 1, Namespace: "default", User: &backend.User{Login: "mutable", Role: "Admin"}, AppInstanceSettings: &backend.AppInstanceSettings{}, GrafanaConfig: config.NewGrafanaCfg(map[string]string{config.AppURL: "https://grafana.example/"})}
	f.body = f.jwks("id-current", key)
	return f
}
func (f *identityFixture) jwks(kid string, key *ecdsa.PrivateKey) string {
	enc := func(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }
	b, _ := json.Marshal(map[string]any{"keys": []any{map[string]any{"kty": "EC", "crv": "P-256", "use": "sig", "alg": "ES256", "kid": kid, "x": enc(key.X.FillBytes(make([]byte, 32))), "y": enc(key.Y.FillBytes(make([]byte, 32)))}}})
	return string(b)
}
func (f *identityFixture) verifier(t *testing.T) *identityVerifier {
	t.Helper()
	c := &http.Client{Timeout: time.Second, Transport: identityRoundTripper(func(r *http.Request) (*http.Response, error) {
		if r.URL.String() != f.cfg.GrafanaJWKSURL || r.Method != "GET" || r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
			t.Errorf("unsafe identity key request")
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		f.calls++
		return &http.Response{StatusCode: f.status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(f.body)), Request: r}, nil
	})}
	v := newIdentityVerifier(f.cfg, c)
	v.now = func() time.Time { return f.now }
	return v
}
func (f *identityFixture) token(t *testing.T, mutate func(jwt.MapClaims), header func(map[string]any)) string {
	t.Helper()
	c := jwt.MapClaims{"iss": "https://grafana.example/", "aud": []string{"org:1"}, "sub": "user:42", "type": "user", "identifier": "stored-uid", "namespace": "default", "role": "Admin", "authenticatedBy": "password", "iat": f.now.Unix(), "exp": f.now.Add(600 * time.Second).Unix()}
	if mutate != nil {
		mutate(c)
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodES256, c)
	tok.Header["kid"] = "id-current"
	tok.Header["typ"] = "jwt"
	if header != nil {
		header(tok.Header)
	}
	raw, err := tok.SignedString(f.key)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}
func identityHeaders(raw string) http.Header { return http.Header{"X-Grafana-Id": []string{raw}} }
func requireIdentityError(t *testing.T, err error, status int) {
	t.Helper()
	var e *IdentityError
	if !errors.As(err, &e) || e.Status != status {
		t.Fatalf("want safe status %d, got %v", status, err)
	}
	if e.Error() != e.Code || strings.Contains(e.Error(), "eyJ") {
		t.Fatal("unsafe identity error")
	}
}

// Removing signature, immutable-subject, context or claim validation must break these tests.
func TestIdentityVerifiedDatabaseSubject(t *testing.T) {
	f := newIdentityFixture(t)
	v := f.verifier(t)
	raw := f.token(t, nil, nil)
	got, err := v.Verify(context.Background(), f.pc, identityHeaders(raw))
	if err != nil {
		t.Fatal(err)
	}
	if got.Subject != "user:42" || got.Role != "Admin" {
		t.Fatalf("wrong verified identity: %+v", got)
	}
	f.pc.User.Login = "renamed@example.test"
	got, err = v.Verify(context.Background(), f.pc, identityHeaders(raw))
	if err != nil || got.Subject != "user:42" {
		t.Fatalf("mutable login affected immutable identity: %v", err)
	}
}

// Grafana13.3 uses go-jose Audience.MarshalJSON, which serializes its single
// organization audience as a JSON string. Array form is also valid JWT syntax.
func TestIdentityAcceptsGrafanaSingleStringAudience(t *testing.T) {
	f := newIdentityFixture(t)
	v := f.verifier(t)
	raw := f.token(t, func(c jwt.MapClaims) { c["aud"] = "org:1" }, nil)
	got, err := v.Verify(context.Background(), f.pc, identityHeaders(raw))
	if err != nil || got.Subject != "user:42" || got.Role != "Admin" {
		t.Fatalf("real Grafana single-audience encoding rejected: %v", err)
	}
}
func TestIdentityRejectsUnverifiedClaims(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(jwt.MapClaims)
		header func(map[string]any)
	}{
		{"issuer", func(c jwt.MapClaims) { c["iss"] = "https://attacker.example/" }, nil},
		{"missing issuer", func(c jwt.MapClaims) { delete(c, "iss") }, nil},
		{"wrong audience", func(c jwt.MapClaims) { c["aud"] = []string{"org:2"} }, nil},
		{"multi audience", func(c jwt.MapClaims) { c["aud"] = []string{"org:1", "org:2"} }, nil},
		{"wrong string audience", func(c jwt.MapClaims) { c["aud"] = "org:2" }, nil},
		{"empty audience", func(c jwt.MapClaims) { c["aud"] = []string{} }, nil},
		{"numeric audience", func(c jwt.MapClaims) { c["aud"] = 1 }, nil},
		{"duplicate audience", func(c jwt.MapClaims) { c["aud"] = []string{"org:1", "org:1"} }, nil},
		{"missing subject", func(c jwt.MapClaims) { delete(c, "sub") }, nil},
		{"username subject", func(c jwt.MapClaims) { c["sub"] = "mutable" }, nil},
		{"zero subject", func(c jwt.MapClaims) { c["sub"] = "user:0" }, nil},
		{"noncanonical subject", func(c jwt.MapClaims) { c["sub"] = "user:042" }, nil},
		{"overflow subject", func(c jwt.MapClaims) { c["sub"] = "user:9223372036854775808" }, nil},
		{"service type", func(c jwt.MapClaims) { c["type"] = "service-account" }, nil},
		{"anonymous type", func(c jwt.MapClaims) { c["type"] = "anonymous" }, nil},
		{"missing type", func(c jwt.MapClaims) { delete(c, "type") }, nil},
		{"namespace", func(c jwt.MapClaims) { c["namespace"] = "org-1" }, nil},
		{"wildcard namespace", func(c jwt.MapClaims) { c["namespace"] = "*" }, nil},
		{"missing exp", func(c jwt.MapClaims) { delete(c, "exp") }, nil},
		{"missing iat", func(c jwt.MapClaims) { delete(c, "iat") }, nil},
		{"expired", func(c jwt.MapClaims) { c["iat"] = frozenIdentityUnix() - 100; c["exp"] = frozenIdentityUnix() - 6 }, nil},
		{"future iat", func(c jwt.MapClaims) { c["iat"] = frozenIdentityUnix() + 6 }, nil},
		{"long lifetime", func(c jwt.MapClaims) { c["exp"] = frozenIdentityUnix() + 601 }, nil},
		{"fractional time", func(c jwt.MapClaims) { c["iat"] = float64(frozenIdentityUnix()) + 0.5 }, nil},
		{"future nbf", func(c jwt.MapClaims) { c["nbf"] = frozenIdentityUnix() + 6 }, nil},
		{"nbf after exp", func(c jwt.MapClaims) { c["nbf"] = frozenIdentityUnix() + 700 }, nil},
		{"role mismatch", func(c jwt.MapClaims) { c["role"] = "Viewer" }, nil},
		{"unknown role", func(c jwt.MapClaims) { c["role"] = "SuperAdmin" }, nil},
		{"render", func(c jwt.MapClaims) { c["authenticatedBy"] = "render" }, nil},
		{"unreviewed auth", func(c jwt.MapClaims) { c["authenticatedBy"] = "oauth_unreviewed" }, nil},
		{"missing auth", func(c jwt.MapClaims) { delete(c, "authenticatedBy") }, nil},
		{"wrong typ", nil, func(h map[string]any) { h["typ"] = "JWT" }},
		{"missing kid", nil, func(h map[string]any) { delete(h, "kid") }},
		{"remote key", nil, func(h map[string]any) { h["jku"] = "https://attacker.example/jwks" }},
		{"remote certificate", nil, func(h map[string]any) { h["x5u"] = "https://attacker.example/cert" }},
		{"critical header", nil, func(h map[string]any) { h["crit"] = []string{"x"} }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newIdentityFixture(t)
			v := f.verifier(t)
			_, err := v.Verify(context.Background(), f.pc, identityHeaders(f.token(t, tc.mutate, tc.header)))
			requireIdentityError(t, err, 401)
		})
	}
	t.Run("forged signature", func(t *testing.T) {
		f := newIdentityFixture(t)
		v := f.verifier(t)
		other, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		f.key = other
		_, err := v.Verify(context.Background(), f.pc, identityHeaders(f.token(t, nil, nil)))
		requireIdentityError(t, err, 401)
	})
	t.Run("HMAC confusion", func(t *testing.T) {
		f := newIdentityFixture(t)
		v := f.verifier(t)
		tok := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{})
		tok.Header["typ"] = "jwt"
		tok.Header["kid"] = "id-current"
		raw, _ := tok.SignedString([]byte("not-an-ecdsa-key"))
		_, err := v.Verify(context.Background(), f.pc, identityHeaders(raw))
		requireIdentityError(t, err, 401)
	})
}
func frozenIdentityUnix() int64 { return time.Date(2026, 11, 3, 0, 0, 0, 0, time.UTC).Unix() }
func TestIdentityRejectsHeadersAndContext(t *testing.T) {
	cases := []struct {
		name   string
		change func(*identityFixture, http.Header)
	}{
		{"missing header", func(_ *identityFixture, h http.Header) { delete(h, "X-Grafana-Id") }},
		{"duplicate header", func(_ *identityFixture, h http.Header) {
			h["X-Grafana-Id"] = append(h["X-Grafana-Id"], h["X-Grafana-Id"][0])
		}},
		{"case duplicate", func(_ *identityFixture, h http.Header) { h["x-grafana-id"] = h["X-Grafana-Id"] }},
		{"oversize", func(_ *identityFixture, h http.Header) { h.Set("X-Grafana-Id", strings.Repeat("a", 16385)) }},
		{"nil user", func(f *identityFixture, _ http.Header) { f.pc.User = nil }},
		{"wrong plugin", func(f *identityFixture, _ http.Header) { f.pc.PluginID = "other-app" }},
		{"wrong org", func(f *identityFixture, _ http.Header) { f.pc.OrgID = 2 }},
		{"wrong namespace", func(f *identityFixture, _ http.Header) { f.pc.Namespace = "org-2" }},
		{"datasource", func(f *identityFixture, _ http.Header) {
			f.pc.DataSourceInstanceSettings = &backend.DataSourceInstanceSettings{}
		}},
		{"no app settings", func(f *identityFixture, _ http.Header) { f.pc.AppInstanceSettings = nil }},
		{"no grafana config", func(f *identityFixture, _ http.Header) { f.pc.GrafanaConfig = nil }},
		{"app url mismatch", func(f *identityFixture, _ http.Header) {
			f.pc.GrafanaConfig = config.NewGrafanaCfg(map[string]string{config.AppURL: "https://other.example/"})
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newIdentityFixture(t)
			v := f.verifier(t)
			h := identityHeaders(f.token(t, nil, nil))
			tc.change(f, h)
			_, err := v.Verify(context.Background(), f.pc, h)
			if err == nil {
				t.Fatal("untrusted identity accepted")
			}
			var e *IdentityError
			if !errors.As(err, &e) || !(e.Status == 401 || e.Status == 403) {
				t.Fatalf("unsafe context failure: %v", err)
			}
		})
	}
}
func TestIdentityJWKSCacheRotationRevocationAndThrottle(t *testing.T) {
	f := newIdentityFixture(t)
	v := f.verifier(t)
	raw := f.token(t, nil, nil)
	if _, err := v.Verify(context.Background(), f.pc, identityHeaders(raw)); err != nil {
		t.Fatal(err)
	}
	if _, err := v.Verify(context.Background(), f.pc, identityHeaders(raw)); err != nil {
		t.Fatal(err)
	}
	if f.calls != 1 {
		t.Fatal("valid cached key unnecessarily refreshed")
	}
	unknown := f.token(t, nil, func(h map[string]any) { h["kid"] = "new-key" })
	for range 20 {
		_, err := v.Verify(context.Background(), f.pc, identityHeaders(unknown))
		requireIdentityError(t, err, 401)
	}
	if f.calls != 1 {
		t.Fatal("unknown kids caused unbounded key refresh")
	}
	f.now = f.now.Add(5 * time.Second)
	f.body = f.jwks("new-key", f.key)
	if _, err := v.Verify(context.Background(), f.pc, identityHeaders(unknown)); err != nil {
		t.Fatalf("rotation rejected: %v", err)
	}
	_, err := v.Verify(context.Background(), f.pc, identityHeaders(raw))
	requireIdentityError(t, err, 401)
	f.now = f.now.Add(60 * time.Second)
	f.status = 503
	_, err = v.Verify(context.Background(), f.pc, identityHeaders(unknown))
	requireIdentityError(t, err, 503)
	_, err = v.Verify(context.Background(), f.pc, identityHeaders(unknown))
	requireIdentityError(t, err, 503)
	if f.calls != 3 {
		t.Fatalf("expired dependency failure not throttled: %d", f.calls)
	}
}
func TestIdentityJWKSRejectsMalformedOrUnusableTrust(t *testing.T) {
	for _, body := range []string{`{"keys":[]}`, `{"keys":[{"kty":"RSA","kid":"id-current","alg":"RS256"}]}`, `{"keys":[{"kty":"EC","kid":"id-current","crv":"P-256","alg":"ES256","use":"sig","x":"AA","y":"AA"}]}`, `{"keys":[]} {}`, strings.Repeat(" ", 65537)} {
		t.Run("bad trust", func(t *testing.T) {
			f := newIdentityFixture(t)
			f.body = body
			v := f.verifier(t)
			_, err := v.Verify(context.Background(), f.pc, identityHeaders(f.token(t, nil, nil)))
			requireIdentityError(t, err, 503)
		})
	}
	t.Run("duplicate kid", func(t *testing.T) {
		f := newIdentityFixture(t)
		var doc map[string][]any
		_ = json.Unmarshal([]byte(f.body), &doc)
		doc["keys"] = append(doc["keys"], doc["keys"][0])
		b, _ := json.Marshal(doc)
		f.body = string(b)
		v := f.verifier(t)
		_, err := v.Verify(context.Background(), f.pc, identityHeaders(f.token(t, nil, nil)))
		requireIdentityError(t, err, 503)
	})
}
func TestIdentityRejectsEnvironmentIssuerFallback(t *testing.T) {
	f := newIdentityFixture(t)
	t.Setenv("GF_APP_URL", f.cfg.GrafanaIssuer)
	f.pc.GrafanaConfig = config.NewGrafanaCfg(map[string]string{})
	v := f.verifier(t)
	_, err := v.Verify(context.Background(), f.pc, identityHeaders(f.token(t, nil, nil)))
	requireIdentityError(t, err, 403)
}

func TestIdentityExplicitAbsentAuthenticationPolicy(t *testing.T) {
	f := newIdentityFixture(t)
	raw := f.token(t, func(c jwt.MapClaims) { delete(c, "authenticatedBy") }, nil)
	v := f.verifier(t)
	_, err := v.Verify(context.Background(), f.pc, identityHeaders(raw))
	requireIdentityError(t, err, 401)
	f.cfg.AllowedAuthMethods = []string{"absent"}
	v = f.verifier(t)
	got, err := v.Verify(context.Background(), f.pc, identityHeaders(raw))
	if err != nil || got.Subject != "user:42" {
		t.Fatalf("explicit absent policy rejected signed user: %v", err)
	}
	raw = f.token(t, func(c jwt.MapClaims) { c["authenticatedBy"] = "absent" }, nil)
	_, err = v.Verify(context.Background(), f.pc, identityHeaders(raw))
	requireIdentityError(t, err, 401)
	f.cfg.AllowedAuthMethods = []string{"render", "absent"}
	v = f.verifier(t)
	raw = f.token(t, func(c jwt.MapClaims) { c["authenticatedBy"] = "render" }, nil)
	_, err = v.Verify(context.Background(), f.pc, identityHeaders(raw))
	requireIdentityError(t, err, 401)
}

func TestIdentityConcurrentKeyMissesAreBounded(t *testing.T) {
	f := newIdentityFixture(t)
	v := f.verifier(t)
	raw := f.token(t, nil, nil)
	var wg sync.WaitGroup
	for range 30 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			got, err := v.Verify(context.Background(), f.pc, identityHeaders(raw))
			if err != nil || got.Subject != "user:42" {
				t.Errorf("concurrent verification failed: %v", err)
			}
		}()
	}
	wg.Wait()
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.calls != 1 {
		t.Fatalf("parallel key miss herd: %d requests", f.calls)
	}
}

func TestIdentityLoopbackHTTPRequiresExplicitOptIn(t *testing.T) {
	cases := []struct {
		name, issuer, keys string
		optIn, allowed     bool
	}{
		{"default denied", "http://localhost:3000/", "http://127.0.0.1:3000/api/signing-keys/keys", false, false},
		{"explicit loopback aliases", "http://localhost:3000/", "http://127.0.0.1:3000/api/signing-keys/keys", true, true},
		{"ipv6 loopback", "http://[::1]:3000/", "http://[::1]:3000/api/signing-keys/keys", true, true},
		{"private IP denied", "http://10.1.2.3:3000/", "http://127.0.0.1:3000/api/signing-keys/keys", true, false},
		{"private DNS denied", "http://grafana:3000/", "http://grafana:3000/api/signing-keys/keys", true, false},
		{"deceptive DNS denied", "http://localhost.attacker.example/", "http://127.0.0.1:3000/api/signing-keys/keys", true, false},
		{"noncanonical IP denied", "http://127.1:3000/", "http://127.0.0.1:3000/api/signing-keys/keys", true, false},
		{"different local service denied", "http://localhost:3000/", "http://127.0.0.1:4000/api/signing-keys/keys", true, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newIdentityFixture(t)
			f.cfg.GrafanaIssuer = tc.issuer
			f.cfg.GrafanaJWKSURL = tc.keys
			f.cfg.AllowLocalHTTP = tc.optIn
			f.pc.GrafanaConfig = config.NewGrafanaCfg(map[string]string{config.AppURL: tc.issuer})
			v := f.verifier(t)
			raw := f.token(t, func(c jwt.MapClaims) { c["iss"] = tc.issuer }, nil)
			got, err := v.Verify(context.Background(), f.pc, identityHeaders(raw))
			if tc.allowed {
				if err != nil || got.Subject != "user:42" {
					t.Fatalf("reviewed same-host opt-in rejected: %v", err)
				}
			} else {
				requireIdentityError(t, err, 503)
			}
		})
	}
}

func TestIdentityInvalidConfigurationFailsClosed(t *testing.T) {
	for _, change := range []func(*IdentityConfig){func(c *IdentityConfig) { c.GrafanaOrgID = 0 }, func(c *IdentityConfig) { c.GrafanaNamespace = "*" }, func(c *IdentityConfig) { c.AllowedAuthMethods = nil }, func(c *IdentityConfig) { c.GrafanaJWKSURL = "https://grafana.example/api/signing-keys/keys?evil=1" }, func(c *IdentityConfig) { c.GrafanaIssuer = "" }} {
		f := newIdentityFixture(t)
		change(&f.cfg)
		v := f.verifier(t)
		_, err := v.Verify(context.Background(), f.pc, identityHeaders(f.token(t, nil, nil)))
		requireIdentityError(t, err, 503)
	}
}
