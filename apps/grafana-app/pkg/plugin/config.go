package plugin

import (
	"crypto/ed25519"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const PluginID = "infrapulse-infrapulse-app"

var canonicalUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
var configToken = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,128}$`)

type publicSettings struct {
	AgentControlURL string `json:"agentControlUrl"`
	GatewayOrigin   string `json:"gatewayOrigin"`
}
type Config struct {
	IdentityConfig
	ManagementURL     *url.URL
	AssertionIssuer   string
	AssertionAudience string
	AssertionKeyID    string
	AssertionContext  string
	SigningKey        ed25519.PrivateKey
	Public            publicSettings
	ManagementCAFile  string
	GrafanaCAFile     string
}

// Only process environment/file mounts are configuration authorities. App jsonData,
// request headers, browser query parameters and JWT issuer never select a destination.
func loadConfig() (Config, error) {
	fail := func() (Config, error) { return Config{}, errors.New("operator_configuration_invalid") }
	required := func(name string) string { return os.Getenv("INFRAPULSE_" + name) }
	if required("IDENTITY_MODE") != "grafana13-id-token" || required("ACCEPT_EXPERIMENTAL_IDENTITY") != "true" {
		return fail()
	}
	allowHTTP := required("ALLOW_PRIVATE_HTTP") == "true"
	management, err := trustedURL(required("MANAGEMENT_URL"), false, allowHTTP)
	if err != nil {
		return fail()
	}
	issuer, err := trustedURL(required("GRAFANA_ISSUER"), true, true)
	if err != nil {
		return fail()
	}
	jwks, err := trustedURL(required("GRAFANA_JWKS_URL"), true, true)
	if err != nil || !strings.HasSuffix(jwks.Path, "/api/signing-keys/keys") {
		return fail()
	}
	org, err := strconv.ParseInt(required("GRAFANA_ORG_ID"), 10, 64)
	if err != nil || org <= 0 || strconv.FormatInt(org, 10) != required("GRAFANA_ORG_ID") {
		return fail()
	}
	namespace := "default"
	if org != 1 {
		namespace = "org-" + strconv.FormatInt(org, 10)
	}
	if required("GRAFANA_NAMESPACE") != namespace {
		return fail()
	}
	authMethods := strings.Split(required("GRAFANA_AUTH_METHODS"), ",")
	if len(authMethods) == 0 || len(authMethods) > 16 {
		return fail()
	}
	for _, method := range authMethods {
		if !configToken.MatchString(method) || method == "render" || method == "anonymous" {
			return fail()
		}
	}
	control, err := trustedURL(required("AGENT_CONTROL_URL"), false, false)
	if err != nil || control.Scheme != "https" {
		return fail()
	}
	gateway, err := trustedURL(required("GATEWAY_ORIGIN"), false, false)
	if err != nil || gateway.Scheme != "https" {
		return fail()
	}
	c := Config{IdentityConfig: IdentityConfig{GrafanaIssuer: issuer.String(), GrafanaJWKSURL: jwks.String(), GrafanaOrgID: org, GrafanaNamespace: namespace, AllowedAuthMethods: authMethods, AllowLocalHTTP: required("ALLOW_LOOPBACK_GRAFANA_HTTP") == "true"},
		ManagementURL: management, AssertionIssuer: required("ASSERTION_ISSUER"), AssertionAudience: required("ASSERTION_AUDIENCE"), AssertionKeyID: required("ASSERTION_KEY_ID"), AssertionContext: required("ASSERTION_CONTEXT"),
		Public: publicSettings{AgentControlURL: control.String(), GatewayOrigin: gateway.String()}, ManagementCAFile: required("MANAGEMENT_CA_FILE"), GrafanaCAFile: required("GRAFANA_CA_FILE")}
	for _, value := range []string{c.AssertionIssuer, c.AssertionAudience} {
		if !configToken.MatchString(value) {
			return fail()
		}
	}
	if !regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`).MatchString(c.AssertionKeyID) {
		return fail()
	}
	if len(c.AssertionContext) < 1 || len(c.AssertionContext) > 256 || strings.ContainsAny(c.AssertionContext, "\r\n\x00") {
		return fail()
	}
	data, err := readBoundedFile(required("ASSERTION_KEY_FILE"), 16384, true)
	if err != nil {
		return fail()
	}
	block, rest := pem.Decode(data)
	if block == nil || block.Type != "PRIVATE KEY" || len(strings.TrimSpace(string(rest))) != 0 {
		return fail()
	}
	key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return fail()
	}
	private, ok := key.(ed25519.PrivateKey)
	if !ok || len(private) != ed25519.PrivateKeySize {
		return fail()
	}
	c.SigningKey = private
	return c, nil
}
func trustedURL(raw string, allowPath, allowPrivateHTTP bool) (*url.URL, error) {
	bad := errors.New("invalid_trusted_url")
	if raw == "" || len(raw) > 2048 || strings.ContainsAny(raw, "\r\n\t\\%\x00") {
		return nil, bad
	}
	for _, ch := range raw {
		if ch < 33 || ch > 126 {
			return nil, bad
		}
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.Opaque != "" || (u.Scheme != "https" && u.Scheme != "http") {
		return nil, bad
	}
	if !allowPath && u.Path != "" && u.Path != "/" {
		return nil, bad
	}
	if strings.Contains(u.Path, "..") || strings.Contains(u.Path, "//") {
		return nil, bad
	}
	if u.Port() != "" {
		port, e := strconv.Atoi(u.Port())
		if e != nil || port < 1 || port > 65535 {
			return nil, bad
		}
	}
	if u.Scheme == "http" {
		host := u.Hostname()
		ip := net.ParseIP(host)
		local := host == "localhost" || (ip != nil && ip.IsLoopback())
		private := ip != nil && ip.IsPrivate()
		dockerName := regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9-]*$`).MatchString(host)
		if !local && !(allowPrivateHTTP && (private || dockerName)) {
			return nil, bad
		}
	}
	if !allowPath {
		u.Path = ""
	}
	return u, nil
}
func readBoundedFile(path string, max int64, secret bool) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() < 1 || info.Size() > max {
		return nil, errors.New("file_unavailable")
	}
	if secret && runtime.GOOS != "windows" && info.Mode().Perm()&0077 != 0 {
		return nil, errors.New("secret_permissions_invalid")
	}
	data, err := os.ReadFile(path)
	if err != nil || len(data) == 0 || int64(len(data)) > max {
		return nil, errors.New("file_unavailable")
	}
	return data, nil
}
func hardenedClient(caFile string) (*http.Client, error) {
	roots, err := x509.SystemCertPool()
	if err != nil {
		return nil, errors.New("tls_trust_unavailable")
	}
	if caFile != "" {
		data, e := readBoundedFile(caFile, 256*1024, false)
		if e != nil || !roots.AppendCertsFromPEM(data) {
			return nil, errors.New("tls_trust_unavailable")
		}
	}
	transport := &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: 3 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: roots}, TLSHandshakeTimeout: 3 * time.Second, ResponseHeaderTimeout: 5 * time.Second,
		MaxResponseHeaderBytes: 16 * 1024, MaxIdleConns: 8, MaxIdleConnsPerHost: 4, IdleConnTimeout: 30 * time.Second, DisableCompression: true}
	return &http.Client{Transport: transport, Timeout: 8 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}, nil
}
