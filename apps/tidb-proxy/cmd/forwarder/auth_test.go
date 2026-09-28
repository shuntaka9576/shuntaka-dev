package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
)

func TestAuthKeyIssuerIssue(t *testing.T) {
	const (
		clientID     = "test-client-id"
		clientSecret = "test-client-secret"
		accessToken  = "test-access-token"
		authKey      = "tskey-auth-test"
	)

	mux := http.NewServeMux()
	server := httptest.NewServer(mux)
	defer server.Close()

	mux.HandleFunc("/oauth/token", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Fatalf("method = %s, want POST", r.Method)
		}
		gotID, gotSecret, ok := r.BasicAuth()
		if !ok || gotID != clientID || gotSecret != clientSecret {
			t.Fatalf("unexpected basic auth: id=%q ok=%v", gotID, ok)
		}
		if err := r.ParseForm(); err != nil {
			t.Fatal(err)
		}
		if got := r.Form.Get("grant_type"); got != "client_credentials" {
			t.Fatalf("grant_type = %q, want client_credentials", got)
		}
		_ = json.NewEncoder(w).Encode(oauthTokenResponse{AccessToken: accessToken})
	})

	mux.HandleFunc("/tailnet/-/keys", func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer "+accessToken {
			t.Fatalf("Authorization = %q", got)
		}
		var got authKeyRequest
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Fatal(err)
		}
		want := authKeyRequest{
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
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("request = %#v, want %#v", got, want)
		}
		_ = json.NewEncoder(w).Encode(authKeyResponse{Key: authKey})
	})

	issuer := authKeyIssuer{
		client:   server.Client(),
		tokenURL: server.URL + "/oauth/token",
		keysURL:  server.URL + "/tailnet/-/keys",
	}
	got, err := issuer.issue(context.Background(), clientID, clientSecret)
	if err != nil {
		t.Fatal(err)
	}
	if got != authKey {
		t.Fatalf("key = %q, want %q", got, authKey)
	}
}

func TestAuthKeyIssuerIssueTokenFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "invalid client", http.StatusUnauthorized)
	}))
	defer server.Close()

	issuer := authKeyIssuer{
		client:   server.Client(),
		tokenURL: server.URL,
		keysURL:  server.URL,
	}
	if _, err := issuer.issue(context.Background(), "client-id", "client-secret"); err == nil {
		t.Fatal("issue() error = nil, want non-nil")
	}
}

func TestAuthKeyIssuerIssueRejectsEmptyKey(t *testing.T) {
	mux := http.NewServeMux()
	server := httptest.NewServer(mux)
	defer server.Close()

	mux.HandleFunc("/oauth/token", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(oauthTokenResponse{AccessToken: "token"})
	})
	mux.HandleFunc("/tailnet/-/keys", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(authKeyResponse{})
	})

	issuer := authKeyIssuer{
		client:   server.Client(),
		tokenURL: server.URL + "/oauth/token",
		keysURL:  server.URL + "/tailnet/-/keys",
	}
	if _, err := issuer.issue(context.Background(), "client-id", "client-secret"); err == nil {
		t.Fatal("issue() error = nil, want non-nil")
	}
}
