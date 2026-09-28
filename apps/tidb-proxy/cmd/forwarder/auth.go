package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	tailscaleOAuthTokenURL = "https://api.tailscale.com/api/v2/oauth/token"
	tailscaleAuthKeysURL   = "https://api.tailscale.com/api/v2/tailnet/-/keys"
	tailscaleProxyTag      = "tag:proxy"
	authKeyExpirySeconds   = 600
	maxResponseBodyBytes   = 4096
	httpTimeout            = 10 * time.Second
)

type oauthTokenResponse struct {
	AccessToken string `json:"access_token"`
}

type authKeyRequest struct {
	Capabilities  authKeyCapabilities `json:"capabilities"`
	ExpirySeconds int                 `json:"expirySeconds"`
}

type authKeyCapabilities struct {
	Devices authKeyDevices `json:"devices"`
}

type authKeyDevices struct {
	Create authKeyCreate `json:"create"`
}

type authKeyCreate struct {
	Reusable      bool     `json:"reusable"`
	Ephemeral     bool     `json:"ephemeral"`
	Preauthorized bool     `json:"preauthorized"`
	Tags          []string `json:"tags"`
}

type authKeyResponse struct {
	Key string `json:"key"`
}

type authKeyIssuer struct {
	client   *http.Client
	tokenURL string
	keysURL  string
}

func issueAuthKey(ctx context.Context, clientID, clientSecret string) (string, error) {
	issuer := authKeyIssuer{
		client:   &http.Client{Timeout: httpTimeout},
		tokenURL: tailscaleOAuthTokenURL,
		keysURL:  tailscaleAuthKeysURL,
	}
	return issuer.issue(ctx, clientID, clientSecret)
}

func (i authKeyIssuer) issue(ctx context.Context, clientID, clientSecret string) (string, error) {
	accessToken, err := i.exchangeToken(ctx, clientID, clientSecret)
	if err != nil {
		return "", fmt.Errorf("exchange OAuth token: %w", err)
	}

	keyReq := authKeyRequest{
		Capabilities: authKeyCapabilities{
			Devices: authKeyDevices{
				Create: authKeyCreate{
					Reusable:      false,
					Ephemeral:     true,
					Preauthorized: true,
					Tags:          []string{tailscaleProxyTag},
				},
			},
		},
		ExpirySeconds: authKeyExpirySeconds,
	}
	body, err := json.Marshal(keyReq)
	if err != nil {
		return "", fmt.Errorf("encode auth key request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, i.keysURL, strings.NewReader(string(body)))
	if err != nil {
		return "", fmt.Errorf("create auth key request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Content-Type", "application/json")

	resp, err := i.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("request auth key: %w", err)
	}
	defer resp.Body.Close()
	respBody, err := readResponseBody(resp.Body)
	if err != nil {
		return "", fmt.Errorf("read auth key response: %w", err)
	}
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return "", fmt.Errorf("auth key API status=%d body=%s", resp.StatusCode, respBody)
	}

	var keyResp authKeyResponse
	if err := json.Unmarshal(respBody, &keyResp); err != nil {
		return "", fmt.Errorf("decode auth key response: %w", err)
	}
	if keyResp.Key == "" {
		return "", errors.New("auth key API returned an empty key")
	}
	return keyResp.Key, nil
}

func (i authKeyIssuer) exchangeToken(ctx context.Context, clientID, clientSecret string) (string, error) {
	form := url.Values{}
	form.Set("grant_type", "client_credentials")
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, i.tokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", fmt.Errorf("create token request: %w", err)
	}
	req.SetBasicAuth(clientID, clientSecret)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := i.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("request token: %w", err)
	}
	defer resp.Body.Close()
	respBody, err := readResponseBody(resp.Body)
	if err != nil {
		return "", fmt.Errorf("read token response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("OAuth token API status=%d body=%s", resp.StatusCode, respBody)
	}

	var token oauthTokenResponse
	if err := json.Unmarshal(respBody, &token); err != nil {
		return "", fmt.Errorf("decode token response: %w", err)
	}
	if token.AccessToken == "" {
		return "", errors.New("OAuth token API returned an empty access token")
	}
	return token.AccessToken, nil
}

func readResponseBody(body io.Reader) ([]byte, error) {
	return io.ReadAll(io.LimitReader(body, maxResponseBodyBytes))
}
