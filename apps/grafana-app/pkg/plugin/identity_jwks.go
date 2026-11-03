package plugin

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"net/http"
	"strings"
	"time"
)

// key serializes refreshes, bounds misses independently of attacker-selected kid,
// and never serves keys beyond the 60-second trust/revocation window.
func (v *identityVerifier) key(ctx context.Context, kid string) (*ecdsa.PublicKey, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	now := v.now()
	fresh := now.Before(v.expires)
	if fresh {
		if key := v.keys[kid]; key != nil {
			return key, nil
		}
	}
	if now.Before(v.nextRefresh) {
		if !fresh {
			return nil, identityDependency()
		}
		return nil, invalidIdentity()
	}
	v.nextRefresh = now.Add(identityRefreshInterval)
	keys, err := v.fetchKeys(ctx)
	if err != nil {
		if !fresh {
			v.keys = nil
			v.expires = time.Time{}
		}
		return nil, identityDependency()
	}
	v.keys = keys
	v.expires = now.Add(identityCacheTTL)
	if key := keys[kid]; key != nil {
		return key, nil
	}
	return nil, invalidIdentity()
}

func (v *identityVerifier) fetchKeys(ctx context.Context) (map[string]*ecdsa.PublicKey, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, v.cfg.GrafanaJWKSURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := v.client.Do(req)
	if err != nil {
		return nil, err
	}
	if resp == nil || resp.Body == nil {
		return nil, errors.New("missing identity trust response")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, errors.New("identity trust unavailable")
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, identityJWKSMaxBytes+1))
	if err != nil || len(body) > identityJWKSMaxBytes {
		return nil, errors.New("identity trust size")
	}
	var doc struct {
		Keys []struct {
			Kty string          `json:"kty"`
			Crv string          `json:"crv"`
			Alg string          `json:"alg"`
			Use string          `json:"use"`
			Kid string          `json:"kid"`
			X   string          `json:"x"`
			Y   string          `json:"y"`
			D   json.RawMessage `json:"d"`
		} `json:"keys"`
	}
	dec := json.NewDecoder(strings.NewReader(string(body)))
	if err := dec.Decode(&doc); err != nil {
		return nil, err
	}
	if err := dec.Decode(new(any)); err != io.EOF {
		return nil, errors.New("trailing identity trust data")
	}
	if len(doc.Keys) == 0 || len(doc.Keys) > 32 {
		return nil, errors.New("identity trust key count")
	}
	keys := map[string]*ecdsa.PublicKey{}
	seen := map[string]bool{}
	for _, jwk := range doc.Keys {
		if !validIdentityKid(jwk.Kid) || seen[jwk.Kid] {
			return nil, errors.New("invalid identity trust key id")
		}
		seen[jwk.Kid] = true
		if len(jwk.D) != 0 {
			return nil, errors.New("private identity trust key")
		}
		if jwk.Kty != "EC" || jwk.Crv != "P-256" || jwk.Alg != "ES256" || jwk.Use != "sig" {
			continue
		}
		x, errX := base64.RawURLEncoding.Strict().DecodeString(jwk.X)
		y, errY := base64.RawURLEncoding.Strict().DecodeString(jwk.Y)
		if errX != nil || errY != nil || len(x) != 32 || len(y) != 32 {
			return nil, errors.New("invalid identity trust point")
		}
		key := &ecdsa.PublicKey{Curve: elliptic.P256(), X: new(big.Int).SetBytes(x), Y: new(big.Int).SetBytes(y)}
		if !key.Curve.IsOnCurve(key.X, key.Y) {
			return nil, errors.New("invalid identity trust curve")
		}
		keys[jwk.Kid] = key
	}
	if len(keys) == 0 {
		return nil, errors.New("no supported identity trust keys")
	}
	return keys, nil
}
