package plugin

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

type previewSender struct{ response *backend.CallResourceResponse }

func (s *previewSender) Send(r *backend.CallResourceResponse) error { s.response = r; return nil }

func configEnvironment(t *testing.T) {
	t.Helper()
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(t.TempDir(), "assertion.pem")
	if err := os.WriteFile(file, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), 0600); err != nil {
		t.Fatal(err)
	}
	for k, v := range map[string]string{
		"IDENTITY_MODE": "grafana13-id-token", "ACCEPT_EXPERIMENTAL_IDENTITY": "true",
		"MANAGEMENT_URL": "http://management:3000", "ALLOW_PRIVATE_HTTP": "true",
		"GRAFANA_ISSUER": "https://grafana.example/", "GRAFANA_JWKS_URL": "https://grafana.example/api/signing-keys/keys",
		"GRAFANA_ORG_ID": "1", "GRAFANA_NAMESPACE": "default", "GRAFANA_AUTH_METHODS": "password",
		"ASSERTION_ISSUER": "test-ui", "ASSERTION_AUDIENCE": "test-management", "ASSERTION_KEY_ID": "test-key",
		"ASSERTION_CONTEXT": "test-instance", "ASSERTION_KEY_FILE": file,
	} {
		t.Setenv("INFRAPULSE_"+k, v)
	}
}

func TestAgentPublicOriginsAllowPrivateHTTP(t *testing.T) {
	configEnvironment(t)
	for _, host := range []string{"172.16.0.4", "192.168.1.10", "[fd00::4]", "127.0.0.1"} {
		t.Run(host, func(t *testing.T) {
			t.Setenv("INFRAPULSE_AGENT_CONTROL_URL", "http://"+host+":3001")
			t.Setenv("INFRAPULSE_GATEWAY_ORIGIN", "http://"+host+":8000")
			cfg, err := loadConfig()
			if err != nil {
				t.Fatalf("approved private HTTP rejected: %v", err)
			}
			if cfg.Public.GatewayOrigin != "http://"+host+":8000" {
				t.Fatal("configured HTTP origin rewritten")
			}
		})
	}
}

func TestAgentPublicOriginsStillRejectUnsafeHTTP(t *testing.T) {
	configEnvironment(t)
	for _, origin := range []string{"http://public.example.com", "http://8.8.8.8", "http://172.16.0.4/path", "http://user:pass@172.16.0.4", "http://172.16.0.4?x=y"} {
		t.Setenv("INFRAPULSE_AGENT_CONTROL_URL", origin)
		t.Setenv("INFRAPULSE_GATEWAY_ORIGIN", "http://172.16.0.4:8000")
		if _, err := loadConfig(); err == nil {
			t.Fatalf("unsafe origin accepted: %s", origin)
		}
	}
}

func TestHTTPProvisioningPreviewKeepsAuthorizationIdentityAndOriginPins(t *testing.T) {
	const serverID = "11111111-1111-4111-8111-111111111111"
	const agentID = "22222222-2222-4222-8222-222222222222"
	const key = "33333333-3333-4333-8333-333333333333.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	for _, tc := range []struct {
		name, configured, returned, role, returnedID string
		want                                         int
	}{
		{"private HTTP", "http://172.16.0.4:8000", "http://172.16.0.4:8000", "Admin", agentID, 200},
		{"HTTPS", "https://metrics.example:8443", "https://metrics.example:8443", "Admin", agentID, 200},
		{"wrong scheme", "http://172.16.0.4:8000", "https://172.16.0.4:8000", "Admin", agentID, 502},
		{"wrong port", "http://172.16.0.4:8000", "http://172.16.0.4:8001", "Admin", agentID, 502},
		{"wrong host", "http://172.16.0.4:8000", "http://172.16.0.5:8000", "Admin", agentID, 502},
		{"wrong identity", "http://172.16.0.4:8000", "http://172.16.0.4:8000", "Admin", serverID, 502},
		{"non admin", "http://172.16.0.4:8000", "http://172.16.0.4:8000", "Viewer", agentID, 403},
	} {
		t.Run(tc.name, func(t *testing.T) {
			app, _ := assertionApp(t)
			app.cfg.Public.GatewayOrigin = tc.configured
			provisionCalls := 0
			app.http = &http.Client{Transport: transportFunc(func(r *http.Request) (*http.Response, error) {
				data := `{"role":"` + tc.role + `"}`
				if r.URL.Path == "/api/v1/agent/provisioning" {
					provisionCalls++
					if r.Header.Get("Authorization") != "Bearer "+key {
						t.Error("wrong Agent credential")
					}
					data = `{"server_id":"` + serverID + `","agent_id":"` + tc.returnedID + `","ingestion":{"base_url":"` + tc.returned + `"}}`
				} else if r.URL.Path != "/api/v1/me" {
					t.Fatalf("unexpected route %s", r.URL.Path)
				}
				return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(data))}, nil
			})}
			sender := &previewSender{}
			body := []byte(`{"api_key":"` + key + `","server_id":"` + serverID + `","agent_id":"` + agentID + `"}`)
			if err := app.previewProvisioning(context.Background(), Identity{Subject: "user:42", Role: "Admin"}, body, sender); err != nil {
				t.Fatal(err)
			}
			if sender.response == nil || sender.response.Status != tc.want {
				t.Fatalf("want status %d, got %#v", tc.want, sender.response)
			}
			if tc.role != "Admin" && provisionCalls != 0 {
				t.Fatal("non-Admin reached key-bearing endpoint")
			}
			if strings.Contains(string(sender.response.Body), key) {
				t.Fatal("credential leaked in response")
			}
		})
	}
}
