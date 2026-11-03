package plugin

import (
	"errors"
	"net/url"
	"regexp"
	"strings"
)

var uuidSegment = `[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`

type allowedRoute struct {
	method string
	path   *regexp.Regexp
	query  map[string]bool
}

func route(method, path string, keys ...string) allowedRoute {
	q := map[string]bool{}
	for _, key := range keys {
		q[key] = true
	}
	return allowedRoute{method, regexp.MustCompile("^" + path + "$"), q}
}

// Explicit capabilities, not a general-purpose HTTP/signing proxy. No internal
// service/status/credential-verification routes or profile-authoring endpoints.
var managementRoutes = []allowedRoute{
	route("GET", `/api/v1/me`),
	route("GET", `/api/v1/servers`, "limit", "cursor", "name", "os", "environment", "group", "archive"),
	route("POST", `/api/v1/servers`),
	route("GET", `/api/v1/servers/`+uuidSegment), route("PATCH", `/api/v1/servers/`+uuidSegment), route("DELETE", `/api/v1/servers/`+uuidSegment),
	route("POST", `/api/v1/servers/`+uuidSegment+`/agents`),
	route("GET", `/api/v1/servers/`+uuidSegment+`/profile`), route("PUT", `/api/v1/servers/`+uuidSegment+`/profile`),
	route("GET", `/api/v1/agents`, "limit", "cursor", "server", "lifecycle"), route("GET", `/api/v1/agents/`+uuidSegment),
	route("POST", `/api/v1/agents/`+uuidSegment+`/(?:disable|enable|retire)`),
	route("POST", `/api/v1/agents/`+uuidSegment+`/credentials`),
	route("GET", `/api/v1/credentials`, "limit", "cursor", "agent", "server"), route("GET", `/api/v1/credentials/`+uuidSegment),
	route("POST", `/api/v1/credentials/`+uuidSegment+`/(?:rotate|revoke)`),
	route("GET", `/api/v1/monitoring-profiles`, "limit", "cursor", "os", "retired", "status"),
	route("GET", `/api/v1/monitoring-profiles/`+uuidSegment),
	route("GET", `/api/v1/monitoring-profiles/`+uuidSegment+`/versions`, "limit", "cursor", "status"),
	route("GET", `/api/v1/profile-versions/`+uuidSegment),
}

func managementTarget(method, rawURL, resourcePath string) (string, error) {
	bad := errors.New("unsupported_resource")
	if len(rawURL) > 8192 || strings.ContainsAny(rawURL, "\r\n\\#\x00") {
		return "", bad
	}
	u, err := url.Parse(rawURL)
	if err != nil || u.IsAbs() || u.Host != "" || u.User != nil || u.Fragment != "" || u.Opaque != "" || u.RawPath != "" || strings.Contains(u.Path, "%") {
		return "", bad
	}
	path := "/" + strings.TrimPrefix(u.Path, "/")
	if path != "/"+strings.TrimPrefix(resourcePath, "/") || strings.Contains(path, "//") || strings.Contains(path, "..") {
		return "", bad
	}
	q, err := url.ParseQuery(u.RawQuery)
	if err != nil || len(q) > 8 {
		return "", bad
	}
	for _, allowed := range managementRoutes {
		if allowed.method != method || !allowed.path.MatchString(path) {
			continue
		}
		for key, values := range q {
			if !allowed.query[key] || len(values) != 1 || len(values[0]) > 2048 {
				return "", bad
			}
		}
		// Preserve the original query octets/order. Never sign one representation and
		// subsequently url.Values.Encode() another. Management validates values/DTOs.
		if u.RawQuery != "" {
			return path + "?" + u.RawQuery, nil
		}
		return path, nil
	}
	return "", bad
}
