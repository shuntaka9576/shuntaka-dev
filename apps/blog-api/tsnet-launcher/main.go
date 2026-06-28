// tsnet-launcher は Lambda コンテナの 1st プロセスとして起動し、
//
//  1. SSM Parameter Store から Tailscale OAuth client_id / client_secret /
//     tailnet suffix を取得
//  2. Tailscale OAuth API で短命 access token を取得
//  3. ephemeral / preauthorized な auth key を発行 (tag:aws-app)
//  4. tsnet.Server で Tailnet に join
//  5. 127.0.0.1:<LISTEN_PORT> -> <TARGET_HOST>.<TAILNET>:<TARGET_PORT> を
//     TCP forward (sqlx 等から見える loopback として TiDB を公開)
//  6. Rust の HTTP server (default: /app/server) を子プロセスで起動し、
//     stdout/stderr を継承、SIGINT/SIGTERM を中継、子の exit code を継承して終了
//
// distroless ベースイメージで動かす前提で CGO_ENABLED=0 で static build する。
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/ssm"
	"tailscale.com/tsnet"
)

const (
	envOAuthClientIDKeyName     = "TS_OAUTH_CLIENT_ID_KEY_NAME"
	envOAuthClientSecretKeyName = "TS_OAUTH_CLIENT_SECRET_KEY_NAME"
	envTailnetSuffixKeyName     = "TS_TAILNET_SUFFIX_KEY_NAME"
	envServerCmd                = "SERVER_CMD"
	envTsnetHostname            = "TSNET_HOSTNAME"
	envForwardListenAddr        = "FORWARD_LISTEN_ADDR"
	envForwardTargetHost        = "FORWARD_TARGET_HOST"
	envForwardTargetPort        = "FORWARD_TARGET_PORT"

	defaultServerCmd         = "/app/server"
	defaultTsnetHostname     = "blog-api-lambda"
	defaultForwardListenAddr = "127.0.0.1:13306"
	defaultForwardTargetHost = "tidb"
	defaultForwardTargetPort = "4000"

	tsnetStateDir = "/tmp/tsnet-state"

	authKeyExpirySeconds = 600

	httpTimeout = 10 * time.Second
)

type launcherConfig struct {
	OAuthClientID     string
	OAuthClientSecret string
	TailnetSuffix     string
	ServerArgv        []string
	Hostname          string
	ListenAddr        string
	ForwardTarget     string
}

func main() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)

	ctx := context.Background()

	cfg, err := loadConfig(ctx)
	if err != nil {
		log.Fatalf("loadConfig: %v", err)
	}
	log.Printf("config loaded: hostname=%s listen=%s target=%s server=%v",
		cfg.Hostname, cfg.ListenAddr, cfg.ForwardTarget, cfg.ServerArgv)

	authKey, err := issueAuthKey(ctx, cfg.OAuthClientID, cfg.OAuthClientSecret)
	if err != nil {
		log.Fatalf("issueAuthKey: %v", err)
	}
	log.Printf("ephemeral auth key issued (%d chars)", len(authKey))

	ts := &tsnet.Server{
		Hostname:  cfg.Hostname,
		AuthKey:   authKey,
		Dir:       tsnetStateDir,
		Ephemeral: true,
	}
	defer ts.Close()

	if _, err := ts.Up(ctx); err != nil {
		log.Fatalf("tsnet.Up: %v", err)
	}
	log.Printf("tsnet up: hostname=%s", cfg.Hostname)

	listener, err := net.Listen("tcp", cfg.ListenAddr)
	if err != nil {
		log.Fatalf("listen %s: %v", cfg.ListenAddr, err)
	}
	log.Printf("forwarder: %s -> tailnet:%s", listener.Addr(), cfg.ForwardTarget)
	go runForwarder(ts, listener, cfg.ForwardTarget)

	// Pre-warm DERP / DNS by dialing once before handing off to Rust.
	prewarmCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	if conn, err := ts.Dial(prewarmCtx, "tcp", cfg.ForwardTarget); err == nil {
		conn.Close()
		log.Printf("forwarder: pre-warm dial ok")
	} else {
		log.Printf("forwarder: pre-warm dial failed: %v", err)
	}
	cancel()

	runServer(cfg.ServerArgv)
}

func loadConfig(ctx context.Context) (*launcherConfig, error) {
	cidName := os.Getenv(envOAuthClientIDKeyName)
	csName := os.Getenv(envOAuthClientSecretKeyName)
	sufName := os.Getenv(envTailnetSuffixKeyName)
	if cidName == "" || csName == "" || sufName == "" {
		return nil, fmt.Errorf("required envs missing: %s / %s / %s",
			envOAuthClientIDKeyName, envOAuthClientSecretKeyName, envTailnetSuffixKeyName)
	}

	serverCmd := getenv(envServerCmd, defaultServerCmd)
	hostname := getenv(envTsnetHostname, defaultTsnetHostname)
	listenAddr := getenv(envForwardListenAddr, defaultForwardListenAddr)
	targetHost := getenv(envForwardTargetHost, defaultForwardTargetHost)
	targetPort := getenv(envForwardTargetPort, defaultForwardTargetPort)

	awsCfg, err := awsconfig.LoadDefaultConfig(ctx)
	if err != nil {
		return nil, fmt.Errorf("aws config: %w", err)
	}
	ssmClient := ssm.NewFromConfig(awsCfg)

	cid, err := getSSMParam(ctx, ssmClient, cidName, true)
	if err != nil {
		return nil, fmt.Errorf("ssm %s: %w", cidName, err)
	}
	csec, err := getSSMParam(ctx, ssmClient, csName, true)
	if err != nil {
		return nil, fmt.Errorf("ssm %s: %w", csName, err)
	}
	suf, err := getSSMParam(ctx, ssmClient, sufName, false)
	if err != nil {
		return nil, fmt.Errorf("ssm %s: %w", sufName, err)
	}

	return &launcherConfig{
		OAuthClientID:     cid,
		OAuthClientSecret: csec,
		TailnetSuffix:     suf,
		ServerArgv:        strings.Fields(serverCmd),
		Hostname:          hostname,
		ListenAddr:        listenAddr,
		ForwardTarget:     fmt.Sprintf("%s.%s:%s", targetHost, suf, targetPort),
	}, nil
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func getSSMParam(ctx context.Context, c *ssm.Client, name string, decrypt bool) (string, error) {
	out, err := c.GetParameter(ctx, &ssm.GetParameterInput{
		Name:           &name,
		WithDecryption: &decrypt,
	})
	if err != nil {
		return "", err
	}
	if out.Parameter == nil || out.Parameter.Value == nil {
		return "", errors.New("ssm parameter value is nil")
	}
	return *out.Parameter.Value, nil
}

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

func issueAuthKey(ctx context.Context, clientID, clientSecret string) (string, error) {
	client := &http.Client{Timeout: httpTimeout}

	// Step 1: OAuth access token
	form := url.Values{}
	form.Set("grant_type", "client_credentials")
	tokReq, err := http.NewRequestWithContext(ctx, http.MethodPost,
		"https://api.tailscale.com/api/v2/oauth/token", strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	tokReq.SetBasicAuth(clientID, clientSecret)
	tokReq.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	tokResp, err := client.Do(tokReq)
	if err != nil {
		return "", err
	}
	tokBody, _ := io.ReadAll(tokResp.Body)
	tokResp.Body.Close()
	if tokResp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("oauth/token status=%d body=%s", tokResp.StatusCode, string(tokBody))
	}
	var tok oauthTokenResponse
	if err := json.Unmarshal(tokBody, &tok); err != nil {
		return "", fmt.Errorf("oauth/token decode: %w", err)
	}
	if tok.AccessToken == "" {
		return "", errors.New("oauth/token: empty access_token")
	}

	// Step 2: ephemeral auth key
	keyReq := authKeyRequest{
		Capabilities: authKeyCapabilities{
			Devices: authKeyDevices{
				Create: authKeyCreate{
					Reusable:      false,
					Ephemeral:     true,
					Preauthorized: true,
					Tags:          []string{"tag:aws-app"},
				},
			},
		},
		ExpirySeconds: authKeyExpirySeconds,
	}
	bodyJSON, err := json.Marshal(keyReq)
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		"https://api.tailscale.com/api/v2/tailnet/-/keys", strings.NewReader(string(bodyJSON)))
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+tok.AccessToken)
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	respBody, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("keys status=%d body=%s", resp.StatusCode, string(respBody))
	}
	var keyResp authKeyResponse
	if err := json.Unmarshal(respBody, &keyResp); err != nil {
		return "", fmt.Errorf("keys decode: %w", err)
	}
	if keyResp.Key == "" {
		return "", errors.New("keys: empty key")
	}
	return keyResp.Key, nil
}

func runForwarder(ts *tsnet.Server, listener net.Listener, target string) {
	for {
		conn, err := listener.Accept()
		if err != nil {
			log.Printf("forwarder accept: %v", err)
			return
		}
		go forwardConn(ts, conn, target)
	}
}

func forwardConn(ts *tsnet.Server, src net.Conn, target string) {
	defer src.Close()

	dialCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	dst, err := ts.Dial(dialCtx, "tcp", target)
	cancel()
	if err != nil {
		log.Printf("forwarder dial %s: %v", target, err)
		return
	}
	defer dst.Close()

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		_, _ = io.Copy(dst, src)
		if c, ok := dst.(interface{ CloseWrite() error }); ok {
			_ = c.CloseWrite()
		}
	}()
	go func() {
		defer wg.Done()
		_, _ = io.Copy(src, dst)
		if c, ok := src.(interface{ CloseWrite() error }); ok {
			_ = c.CloseWrite()
		}
	}()
	wg.Wait()
}

func runServer(argv []string) {
	if len(argv) == 0 {
		log.Fatalf("server cmd is empty")
	}
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Stdin = os.Stdin

	if err := cmd.Start(); err != nil {
		log.Fatalf("server start: %v", err)
	}
	log.Printf("server started: pid=%d cmd=%v", cmd.Process.Pid, argv)

	sigC := make(chan os.Signal, 1)
	signal.Notify(sigC, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		for s := range sigC {
			_ = cmd.Process.Signal(s)
		}
	}()

	err := cmd.Wait()
	signal.Stop(sigC)
	close(sigC)

	if err == nil {
		return
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		os.Exit(exitErr.ExitCode())
	}
	log.Fatalf("server wait: %v", err)
}
