package plugin

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strconv"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

const attachmentMaxBytes = 262144

// managementAttachment is exclusively the one-shot B4 bootstrap transport. The
// caller supplies the verified Grafana user; Management makes the Admin decision.
func (a *App) managementAttachment(ctx context.Context, actor Identity, target string, body []byte) (*backend.CallResourceResponse, error) {
	unavailable := errors.New("management_unavailable")
	match := bootstrapAttachmentPath.FindStringSubmatch(target)
	if len(match) != 2 || !json.Valid(body) {
		return nil, errors.New("unsupported_resource")
	}
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	out, err := http.NewRequestWithContext(ctx, "POST", a.cfg.ManagementURL.String()+target, bytes.NewReader(body))
	if err != nil || out.URL.RequestURI() != target {
		return nil, unavailable
	}
	// No GetBody or idempotency headers: neither redirects nor a stale connection
	// may trigger replay of this irreversible POST. Never retry after cancellation.
	out.GetBody = nil
	authorization, err := a.assertion(actor, "POST", out.URL.RequestURI(), body)
	if err != nil {
		return nil, unavailable
	}
	out.Header.Set("Authorization", "Bearer "+authorization)
	out.Header.Set("Content-Type", "application/json")
	out.Header.Set("Accept", "text/x-shellscript, text/plain, application/json")
	out.Header.Set("User-Agent", "InfraPulse-Grafana-App/1.0.0")
	client := *a.http
	client.Jar = nil
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, err := client.Do(out)
	if err != nil {
		return nil, unavailable
	}
	defer response.Body.Close()
	jsonResponse := func(status int, data []byte) *backend.CallResourceResponse {
		return &backend.CallResourceResponse{Status: status, Headers: map[string][]string{
			"Content-Type": {"application/json; charset=utf-8"}, "Cache-Control": {"no-store, private"},
			"Pragma": {"no-cache"}, "X-Content-Type-Options": {"nosniff"},
		}, Body: data}
	}
	if response.StatusCode >= 300 && response.StatusCode < 400 {
		return jsonResponse(502, []byte(`{"code":"upstream_redirect_rejected"}`)), nil
	}
	if response.ContentLength > attachmentMaxBytes {
		return jsonResponse(502, []byte(`{"code":"invalid_upstream_response"}`)), nil
	}
	// Content-Length is not a bound: chunked and unknown-length responses must
	// traverse the same cap+1 reader before any secret bytes reach the SDK sender.
	data, err := io.ReadAll(io.LimitReader(response.Body, attachmentMaxBytes+1))
	if err != nil || ctx.Err() != nil {
		return nil, unavailable
	}
	if len(data) > attachmentMaxBytes {
		return jsonResponse(502, []byte(`{"code":"invalid_upstream_response"}`)), nil
	}
	if response.StatusCode >= 400 && response.StatusCode <= 599 {
		contentType, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
		if err != nil || len(response.Header.Values("Content-Type")) != 1 || contentType != "application/json" || !json.Valid(data) {
			return jsonResponse(502, []byte(`{"code":"invalid_upstream_response"}`)), nil
		}
		// Reuse the existing error projection, but attachment errors expose no
		// legacy credential metadata: only its validated code and request identity.
		var safe struct {
			Code      string `json:"code,omitempty"`
			RequestID string `json:"request_id,omitempty"`
		}
		_ = json.Unmarshal(safeError(data), &safe)
		projected, _ := json.Marshal(safe)
		return jsonResponse(response.StatusCode, projected), nil
	}
	contentType := response.Header.Get("Content-Type")
	extension := ""
	switch contentType {
	case "text/x-shellscript":
		extension = ".sh"
	case "text/plain":
		extension = ".ps1"
	}
	disposition := `attachment; filename="infrapulse-` + match[1] + extension + `"`
	if response.StatusCode != http.StatusOK || len(data) == 0 || extension == "" || len(response.Header.Values("Content-Encoding")) != 0 ||
		len(response.Header.Values("Content-Type")) != 1 || len(response.Header.Values("Content-Disposition")) != 1 ||
		response.Header.Get("Content-Disposition") != disposition {
		return jsonResponse(502, []byte(`{"code":"invalid_upstream_response"}`)), nil
	}
	// Synthesize only known headers. Never forward Location, cookies, arbitrary
	// upstream headers, filenames, charset parameters, or content dispositions.
	return &backend.CallResourceResponse{Status: http.StatusOK, Headers: map[string][]string{
		"Content-Type": {contentType}, "Content-Disposition": {disposition}, "Content-Length": {strconv.Itoa(len(data))},
		"Cache-Control": {"no-store, private"}, "Pragma": {"no-cache"}, "X-Content-Type-Options": {"nosniff"},
	}, Body: data}, nil
}
