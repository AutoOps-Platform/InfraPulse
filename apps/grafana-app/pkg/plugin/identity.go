package plugin

import (
	"context"
	"crypto/ecdsa"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

// IdentityConfig is an explicitly enrolled, single-tenant Grafana instance.
// No value is discovered from a token, browser request, or default organization.
type IdentityConfig struct {
	GrafanaIssuer      string
	GrafanaJWKSURL     string
	GrafanaOrgID       int64
	GrafanaNamespace   string
	AllowedAuthMethods []string
	// AllowLocalHTTP is an explicit development-only same-host channel opt-in.
	AllowLocalHTTP bool
}

type Identity struct {
	Subject string
	Role    string
}

// IdentityError never retains parser, HTTP, token, or key material.
type IdentityError struct {
	Status int
	Code   string
}

func (e *IdentityError) Error() string { return e.Code }
func invalidIdentity() *IdentityError  { return &IdentityError{Status: 401, Code: "unauthorized"} }
func identityPolicy() *IdentityError   { return &IdentityError{Status: 403, Code: "forbidden"} }
func identityDependency() *IdentityError {
	return &IdentityError{Status: 503, Code: "dependency_unavailable"}
}

const identityTokenLimit = 16384
const identityJWKSMaxBytes = 64 * 1024
const identityCacheTTL = 60 * time.Second
const identityRefreshInterval = 5 * time.Second

type identityVerifier struct {
	cfg         IdentityConfig
	client      *http.Client
	ready       bool
	now         func() time.Time
	mu          sync.Mutex
	keys        map[string]*ecdsa.PublicKey
	expires     time.Time
	nextRefresh time.Time
}

func newIdentityVerifier(cfg IdentityConfig, client *http.Client) *identityVerifier {
	cfg.AllowedAuthMethods = append([]string(nil), cfg.AllowedAuthMethods...)
	v := &identityVerifier{cfg: cfg, now: time.Now}
	expectedNamespace := fmt.Sprintf("org-%d", cfg.GrafanaOrgID)
	if cfg.GrafanaOrgID == 1 {
		expectedNamespace = "default"
	}
	if cfg.GrafanaOrgID <= 0 || cfg.GrafanaNamespace != expectedNamespace || len(cfg.AllowedAuthMethods) == 0 || client == nil || !validIdentityURL(cfg.GrafanaIssuer, cfg.AllowLocalHTTP) || !validIdentityURL(cfg.GrafanaJWKSURL, cfg.AllowLocalHTTP) {
		return v
	}
	issuerURL, _ := url.Parse(cfg.GrafanaIssuer)
	keyURL, _ := url.Parse(cfg.GrafanaJWKSURL)
	if issuerURL.Scheme == "http" && keyURL.Scheme == "http" && identityURLPort(issuerURL) != identityURLPort(keyURL) {
		return v
	}
	if !strings.HasSuffix(mustIdentityPath(cfg.GrafanaJWKSURL), "/api/signing-keys/keys") {
		return v
	}
	for _, method := range cfg.AllowedAuthMethods {
		if method == "" || len(method) > 128 || strings.TrimSpace(method) != method || strings.ContainsAny(method, "\r\n\x00") {
			return v
		}
	}
	// Copy rather than mutate the caller's shared client; never follow key redirects.
	c := *client
	c.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	v.client = &c
	v.ready = true
	return v
}
func validIdentityURL(raw string, allowLocalHTTP bool) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.Opaque != "" || strings.ContainsAny(raw, "\r\n\x00") {
		return false
	}
	if port := u.Port(); port != "" {
		number, err := strconv.ParseInt(port, 10, 32)
		if err != nil || number < 1 || number > 65535 {
			return false
		}
	}
	if u.Scheme == "https" {
		return true
	}
	if u.Scheme != "http" || !allowLocalHTTP {
		return false
	}
	switch strings.ToLower(u.Hostname()) {
	case "localhost", "127.0.0.1", "::1":
		return true
	default:
		return false
	}
}
func identityURLPort(u *url.URL) string {
	if u.Port() != "" {
		return u.Port()
	}
	if u.Scheme == "http" {
		return "80"
	}
	return "443"
}
func mustIdentityPath(raw string) string { u, _ := url.Parse(raw); return u.Path }

func (v *identityVerifier) Verify(ctx context.Context, pc backend.PluginContext, headers http.Header) (Identity, error) {
	if v == nil || !v.ready {
		return Identity{}, identityDependency()
	}
	if pc.User == nil {
		return Identity{}, invalidIdentity()
	}
	if pc.PluginID != "infrapulse-infrapulse-app" || pc.OrgID != v.cfg.GrafanaOrgID || pc.Namespace != v.cfg.GrafanaNamespace || pc.DataSourceInstanceSettings != nil || pc.AppInstanceSettings == nil || pc.GrafanaConfig == nil {
		return Identity{}, identityPolicy()
	}
	appURL, err := pc.GrafanaConfig.AppURL()
	if err != nil || appURL != v.cfg.GrafanaIssuer || pc.GrafanaConfig.Get(backend.AppURL) != v.cfg.GrafanaIssuer {
		return Identity{}, identityPolicy()
	}
	var raw string
	count := 0
	for name, values := range headers {
		if strings.EqualFold(name, "X-Grafana-Id") {
			count++
			if len(values) != 1 {
				return Identity{}, invalidIdentity()
			}
			raw = values[0]
		}
	}
	if count != 1 || len(raw) == 0 || len(raw) > identityTokenLimit || strings.TrimSpace(raw) != raw {
		return Identity{}, invalidIdentity()
	}
	header, err := identityProtectedHeader(raw)
	if err != nil {
		return Identity{}, invalidIdentity()
	}
	key, err := v.key(ctx, header["kid"])
	if err != nil {
		return Identity{}, err
	}
	token, err := jwt.Parse(raw, func(t *jwt.Token) (any, error) {
		if t.Method != jwt.SigningMethodES256 {
			return nil, errors.New("unsupported identity algorithm")
		}
		return key, nil
	}, jwt.WithValidMethods([]string{"ES256"}), jwt.WithJSONNumber(), jwt.WithoutClaimsValidation(), jwt.WithStrictDecoding())
	if err != nil || token == nil || !token.Valid {
		return Identity{}, invalidIdentity()
	}
	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok {
		return Identity{}, invalidIdentity()
	}
	issuer, _ := claims["iss"].(string)
	subject, _ := claims["sub"].(string)
	kind, _ := claims["type"].(string)
	namespace, _ := claims["namespace"].(string)
	role, _ := claims["role"].(string)
	// Grafana13.3's go-jose marshaler emits a single audience as a JSON
	// string. JWT also permits a singleton array; neither form may widen the
	// enrolled organization audience or accept multiple/duplicate audiences.
	expectedAudience := fmt.Sprintf("org:%d", v.cfg.GrafanaOrgID)
	audienceOK := false
	switch aud := claims["aud"].(type) {
	case string:
		audienceOK = aud == expectedAudience
	case []any:
		audienceOK = len(aud) == 1 && aud[0] == expectedAudience
	}
	if issuer != v.cfg.GrafanaIssuer || !audienceOK || !validIdentitySubject(subject) || kind != "user" || namespace != v.cfg.GrafanaNamespace || (role != "Viewer" && role != "Editor" && role != "Admin") || role != pc.User.Role {
		return Identity{}, invalidIdentity()
	}
	// Use exact integer NumericDates. The library's default validation permits missing
	// times and implicit leeway, neither of which is appropriate for this boundary.
	iat, okIat := identityInteger(claims, "iat")
	exp, okExp := identityInteger(claims, "exp")
	now := v.now().Unix()
	if !okIat || !okExp || iat <= 0 || exp <= iat || exp-iat > 600 || iat > now+5 || exp <= now-5 {
		return Identity{}, invalidIdentity()
	}
	if _, present := claims["nbf"]; present {
		nbf, ok := identityInteger(claims, "nbf")
		if !ok || nbf < 0 || nbf > now+5 || nbf >= exp {
			return Identity{}, invalidIdentity()
		}
	}
	authMethod := ""
	if value, present := claims["authenticatedBy"]; present {
		var ok bool
		authMethod, ok = value.(string)
		if !ok {
			return Identity{}, invalidIdentity()
		}
	}
	if authMethod == "render" {
		return Identity{}, invalidIdentity()
	}
	allowed := false
	for _, method := range v.cfg.AllowedAuthMethods {
		if (authMethod != "" && authMethod == method && method != "absent") || (authMethod == "" && method == "absent") {
			allowed = true
			break
		}
	}
	if !allowed {
		return Identity{}, invalidIdentity()
	}
	return Identity{Subject: subject, Role: role}, nil
}
func validIdentitySubject(subject string) bool {
	if !strings.HasPrefix(subject, "user:") {
		return false
	}
	raw := strings.TrimPrefix(subject, "user:")
	id, err := strconv.ParseInt(raw, 10, 64)
	return err == nil && id > 0 && strconv.FormatInt(id, 10) == raw
}
func identityInteger(claims jwt.MapClaims, name string) (int64, bool) {
	n, ok := claims[name].(json.Number)
	if !ok {
		return 0, false
	}
	i, err := n.Int64()
	return i, err == nil
}

// Reject duplicate and unsupported protected headers before any key retrieval.
// Grafana 13.3.0 emits exactly alg/typ/kid; a JWT is never a discovery document.
func identityProtectedHeader(raw string) (map[string]string, error) {
	parts := strings.Split(raw, ".")
	if len(parts) != 3 {
		return nil, errors.New("invalid identity")
	}
	b, err := base64.RawURLEncoding.Strict().DecodeString(parts[0])
	if err != nil {
		return nil, err
	}
	dec := json.NewDecoder(strings.NewReader(string(b)))
	tok, err := dec.Token()
	if err != nil || tok != json.Delim('{') {
		return nil, errors.New("invalid identity")
	}
	out := map[string]string{}
	for dec.More() {
		field, err := dec.Token()
		if err != nil {
			return nil, err
		}
		name, ok := field.(string)
		if !ok {
			return nil, errors.New("invalid identity")
		}
		if name != "alg" && name != "typ" && name != "kid" {
			return nil, errors.New("unsupported identity header")
		}
		if _, exists := out[name]; exists {
			return nil, errors.New("duplicate identity header")
		}
		var value string
		if err := dec.Decode(&value); err != nil {
			return nil, err
		}
		out[name] = value
	}
	if _, err := dec.Token(); err != nil {
		return nil, err
	}
	if err := dec.Decode(new(any)); err != io.EOF {
		return nil, errors.New("invalid identity header")
	}
	if len(out) != 3 || out["alg"] != "ES256" || out["typ"] != "jwt" || !validIdentityKid(out["kid"]) {
		return nil, errors.New("invalid identity header")
	}
	return out, nil
}
func validIdentityKid(kid string) bool {
	if len(kid) == 0 || len(kid) > 128 {
		return false
	}
	for _, c := range kid {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '.' || c == '_' || c == '-' || c == ':') {
			return false
		}
	}
	return true
}
