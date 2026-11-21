package plugin

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/instancemgmt"
)

type App struct {
	cfg          Config
	identity     *identityVerifier
	http         *http.Client
	identityHTTP *http.Client
}

var _ backend.CallResourceHandler = (*App)(nil)
var _ backend.CheckHealthHandler = (*App)(nil)
var _ instancemgmt.InstanceDisposer = (*App)(nil)

func NewApp(_ context.Context, _ backend.AppInstanceSettings) (instancemgmt.Instance, error) {
	cfg, err := loadConfig()
	if err != nil {
		return nil, errors.New("operator_configuration_invalid")
	}
	management, err := hardenedClient(cfg.ManagementCAFile)
	if err != nil {
		return nil, err
	}
	grafana, err := hardenedClient(cfg.GrafanaCAFile)
	if err != nil {
		management.CloseIdleConnections()
		return nil, err
	}
	identity := newIdentityVerifier(cfg.IdentityConfig, grafana)
	if !identity.ready {
		management.CloseIdleConnections()
		grafana.CloseIdleConnections()
		return nil, errors.New("operator_configuration_invalid")
	}
	return &App{cfg: cfg, identity: identity, http: management, identityHTTP: grafana}, nil
}
func (a *App) Dispose() { a.http.CloseIdleConnections(); a.identityHTTP.CloseIdleConnections() }
func (a *App) CheckHealth(_ context.Context, _ *backend.CheckHealthRequest) (*backend.CheckHealthResult, error) {
	// No privileged synthetic user, no fake /me proof from a health callback. Actual
	// authenticated requests independently verify identity and Management reachability.
	return &backend.CheckHealthResult{Status: backend.HealthStatusOk, Message: "Adapter configured; user identity and Management access are checked on every request"}, nil
}
func send(sender backend.CallResourceResponseSender, status int, data []byte) error {
	return sender.Send(&backend.CallResourceResponse{Status: status, Headers: map[string][]string{
		"Content-Type": {"application/json; charset=utf-8"}, "Cache-Control": {"no-store, private"}, "Pragma": {"no-cache"}, "X-Content-Type-Options": {"nosniff"},
	}, Body: data})
}
func failure(sender backend.CallResourceResponseSender, status int, code string) error {
	body, _ := json.Marshal(map[string]string{"code": code})
	return send(sender, status, body)
}
func (a *App) CallResource(ctx context.Context, req *backend.CallResourceRequest, sender backend.CallResourceResponseSender) error {
	if req == nil {
		return failure(sender, 400, "invalid_request")
	}
	if len(req.Body) > 128*1024 {
		return failure(sender, 413, "payload_too_large")
	}
	actor, err := a.identity.Verify(ctx, req.PluginContext, req.GetHTTPHeaders())
	if err != nil {
		var identityErr *IdentityError
		if errors.As(err, &identityErr) {
			return failure(sender, identityErr.Status, identityErr.Code)
		}
		return failure(sender, 401, "unauthorized")
	}
	target, err := managementTarget(req.Method, req.URL, req.Path)
	if err != nil {
		return failure(sender, 400, "unsupported_resource")
	}
	if req.Method == "GET" && len(req.Body) != 0 {
		return failure(sender, 400, "invalid_request")
	}
	if len(req.Body) > 0 && !json.Valid(req.Body) {
		return failure(sender, 400, "invalid_request")
	}
	if req.Method == "POST" && bootstrapAttachmentPath.MatchString(target) {
		if len(req.Body) == 0 {
			return failure(sender, 400, "invalid_request")
		}
		response, err := a.managementAttachment(ctx, actor, target, req.Body)
		if err != nil {
			// A lost response is an unknown outcome, never permission to replay the POST.
			// The caller must inspect GET onboarding progress before any explicit intent.
			return failure(sender, 503, "management_unavailable")
		}
		return sender.Send(response)
	}
	status, data, err := a.management(ctx, actor, req.Method, target, req.Body, "")
	if err != nil {
		return failure(sender, 503, "management_unavailable")
	}
	return send(sender, status, data)
}
func (a *App) assertion(actor Identity, method, target string, body []byte) (string, error) {
	now := time.Now().Unix()
	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err != nil {
		return "", errors.New("assertion_unavailable")
	}
	nonce[6] = (nonce[6] & 0x0f) | 0x40
	nonce[8] = (nonce[8] & 0x3f) | 0x80
	jti := fmt.Sprintf("%x-%x-%x-%x-%x", nonce[:4], nonce[4:6], nonce[6:8], nonce[8:10], nonce[10:])
	digest := sha256.Sum256(body)
	token := jwt.NewWithClaims(jwt.SigningMethodEdDSA, jwt.MapClaims{
		"iss": a.cfg.AssertionIssuer, "aud": a.cfg.AssertionAudience, "sub": actor.Subject, "kind": "user", "ctx": a.cfg.AssertionContext, "grafana_role": actor.Role,
		"iat": now, "nbf": now, "exp": now + 30, "jti": jti, "m": method, "t": target, "b": base64.RawURLEncoding.EncodeToString(digest[:]),
	})
	token.Header["kid"] = a.cfg.AssertionKeyID
	return token.SignedString(ed25519.PrivateKey(a.cfg.SigningKey))
}
func (a *App) management(ctx context.Context, actor Identity, method, target string, body []byte, agentKey string) (int, []byte, error) {
	// The Management URL is origin-only. Construct once; bind and transmit the same
	// RequestURI and raw body. No retry, redirects, ambient proxy, cookie or browser auth.
	out, err := http.NewRequestWithContext(ctx, method, a.cfg.ManagementURL.String()+target, bytes.NewReader(body))
	if err != nil {
		return 0, nil, errors.New("management_unavailable")
	}
	// Retained parameter shape for archival callers; Agent keys are never sent.
	if agentKey != "" {
		return 0, nil, errors.New("unsupported_resource")
	}
	authorization, err := a.assertion(actor, method, out.URL.RequestURI(), body)
	if err != nil {
		return 0, nil, err
	}
	out.Header.Set("Authorization", "Bearer "+authorization)
	out.Header.Set("Accept", "application/json")
	out.Header.Set("User-Agent", "InfraPulse-Grafana-App/1.0.0")
	if len(body) > 0 {
		out.Header.Set("Content-Type", "application/json")
	}
	response, err := a.http.Do(out)
	if err != nil {
		return 0, nil, errors.New("management_unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 && response.StatusCode < 400 {
		return 502, []byte(`{"code":"upstream_redirect_rejected"}`), nil
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 8*1024*1024+1))
	if err != nil || len(data) > 8*1024*1024 {
		return 0, nil, errors.New("management_unavailable")
	}
	if response.StatusCode == 204 {
		return 204, nil, nil
	}
	if !strings.HasPrefix(strings.ToLower(response.Header.Get("Content-Type")), "application/json") || !json.Valid(data) {
		return 502, []byte(`{"code":"invalid_upstream_response"}`), nil
	}
	if response.StatusCode >= 400 {
		return response.StatusCode, safeError(data), nil
	}
	return response.StatusCode, data, nil
}
func safeError(raw []byte) []byte {
	var payload map[string]json.RawMessage
	if json.Unmarshal(raw, &payload) != nil {
		return []byte(`{"code":"request_failed"}`)
	}
	result := map[string]json.RawMessage{}
	for _, key := range []string{"code", "request_id"} {
		var text string
		if json.Unmarshal(payload[key], &text) == nil && ((key == "code" && regexpCode(text)) || (key == "request_id" && canonicalUUID.MatchString(text))) {
			result[key] = payload[key]
		}
	}
	if len(result) == 0 {
		return []byte(`{"code":"request_failed"}`)
	}
	data, _ := json.Marshal(result)
	return data
}
func regexpCode(value string) bool {
	if len(value) < 1 || len(value) > 64 {
		return false
	}
	for _, r := range value {
		if r != '_' && (r < 'a' || r > 'z') {
			return false
		}
	}
	return true
}
// ARCHIVAL symbol retained for historical source-shape compatibility only; no
// route or key-bearing transport remains. AWS uses managementAttachment instead.
func (a *App) previewProvisioning(_ context.Context, _ Identity, _ []byte, sender backend.CallResourceResponseSender) error {
	return failure(sender, 400, "unsupported_resource")
}
