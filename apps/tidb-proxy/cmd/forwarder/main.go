// tidb-proxy forwarder は Fargate task のメインプロセスとして起動し、
//
//  1. 環境変数 TS_AUTHKEY (reusable / non-ephemeral / tag:proxy で発行済み)
//     を使って tsnet.Server で Tailnet に join
//  2. 0.0.0.0:<LISTEN_PORT> -> <TIDB_HOSTNAME>.<TAILNET_SUFFIX>:<TIDB_PORT>
//     を TCP forward (Lambda から見える VPC 内エンドポイントとして TiDB を公開)
//
// alpine ベース image で動かす前提で CGO_ENABLED=0 で static build する。
//
// blog-api/tsnet-launcher との差分:
//   - SSM Parameter Store / OAuth client_credentials による auth key 発行を削除
//     (常駐 proxy なので reusable / non-ephemeral / tagged な auth key を
//      ecspresso 経由で SSM から runtime fetch する想定)
//   - Rust HTTP server を子プロセス起動するロジックを削除 (forwarder のみ)
//   - listen を 127.0.0.1 ではなく 0.0.0.0 にして同 VPC 内 Lambda から到達可能に
//   - state dir を /var/lib/tsnet-state (コンテナ内の通常パス) に変更
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"tailscale.com/tsnet"
)

const (
	envTSAuthKey         = "TS_AUTHKEY"
	envTailnetSuffix     = "TAILNET_SUFFIX"
	envTsnetHostname     = "TSNET_HOSTNAME"
	envForwardListenAddr = "FORWARD_LISTEN_ADDR"
	envTidbHostname      = "TIDB_HOSTNAME"
	envTidbPort          = "TIDB_PORT"
	envTsnetStateDir     = "TSNET_STATE_DIR"

	defaultTsnetHostname     = "tidb-proxy"
	defaultForwardListenAddr = "0.0.0.0:13306"
	defaultTidbHostname      = "tidb"
	defaultTidbPort          = "4000"
	defaultTsnetStateDir     = "/var/lib/tsnet-state"
)

type forwarderConfig struct {
	AuthKey       string
	Hostname      string
	ListenAddr    string
	ForwardTarget string
	StateDir      string
}

func main() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)

	cfg, err := loadConfig()
	if err != nil {
		log.Fatalf("loadConfig: %v", err)
	}
	log.Printf("config loaded: hostname=%s listen=%s target=%s stateDir=%s",
		cfg.Hostname, cfg.ListenAddr, cfg.ForwardTarget, cfg.StateDir)

	if err := os.MkdirAll(cfg.StateDir, 0o700); err != nil {
		log.Fatalf("mkdir state dir %s: %v", cfg.StateDir, err)
	}

	ts := &tsnet.Server{
		Hostname:  cfg.Hostname,
		AuthKey:   cfg.AuthKey,
		Dir:       cfg.StateDir,
		Ephemeral: false,
	}
	defer ts.Close()

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	if _, err := ts.Up(ctx); err != nil {
		log.Fatalf("tsnet.Up: %v", err)
	}
	log.Printf("tsnet up: hostname=%s", cfg.Hostname)

	listener, err := net.Listen("tcp", cfg.ListenAddr)
	if err != nil {
		log.Fatalf("listen %s: %v", cfg.ListenAddr, err)
	}
	defer listener.Close()
	log.Printf("forwarder: %s -> tailnet:%s", listener.Addr(), cfg.ForwardTarget)

	// ts.Dial は tsnet 内部 dialer 経由で netmap に居る peer の MagicDNS 名を解決する。
	// ACL で tag:proxy -> tag:k8s (TiDB Operator Proxy) が許可されていれば
	// `tidb.<TAILNET_SUFFIX>` が解決可能になる。未許可だと netmap に peer が無く
	// OS resolver にフォールバックして NXDOMAIN になるので、ACL 設定漏れに注意。
	go runForwarder(ts, listener, cfg.ForwardTarget)

	// Pre-warm DERP / DNS by dialing once.
	prewarmCtx, prewarmCancel := context.WithTimeout(ctx, 10*time.Second)
	if conn, err := ts.Dial(prewarmCtx, "tcp", cfg.ForwardTarget); err == nil {
		_ = conn.Close()
		log.Printf("forwarder: pre-warm dial ok")
	} else {
		log.Printf("forwarder: pre-warm dial failed: %v", err)
	}
	prewarmCancel()

	<-ctx.Done()
	log.Printf("shutdown signal received, exiting")
}

func loadConfig() (*forwarderConfig, error) {
	authKey := os.Getenv(envTSAuthKey)
	if authKey == "" {
		return nil, fmt.Errorf("required env missing: %s", envTSAuthKey)
	}
	suffix := os.Getenv(envTailnetSuffix)
	if suffix == "" {
		return nil, fmt.Errorf("required env missing: %s", envTailnetSuffix)
	}

	hostname := getenv(envTsnetHostname, defaultTsnetHostname)
	listenAddr := getenv(envForwardListenAddr, defaultForwardListenAddr)
	tidbHost := getenv(envTidbHostname, defaultTidbHostname)
	tidbPort := getenv(envTidbPort, defaultTidbPort)
	stateDir := getenv(envTsnetStateDir, defaultTsnetStateDir)

	return &forwarderConfig{
		AuthKey:       authKey,
		Hostname:      hostname,
		ListenAddr:    listenAddr,
		ForwardTarget: fmt.Sprintf("%s.%s:%s", tidbHost, suffix, tidbPort),
		StateDir:      stateDir,
	}, nil
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func runForwarder(ts *tsnet.Server, listener net.Listener, target string) {
	for {
		conn, err := listener.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
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
