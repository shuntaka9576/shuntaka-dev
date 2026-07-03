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
//     ecspresso 経由で SSM から runtime fetch する想定)
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
	"strconv"
	"sync"
	"syscall"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"
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
	// ForwardTarget のホスト論理名 (例: "tidb")。span/metric の
	// proxy.upstream.name 属性に使う。
	UpstreamName string
	StateDir     string
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

	tel, err := setupTelemetry(ctx, cfg.UpstreamName)
	if err != nil {
		log.Fatalf("setupTelemetry: %v", err)
	}

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
	go runForwarder(ts, listener, cfg.ForwardTarget, tel)

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

	// 溜まっている traces / metrics を送り切ってから終了する。
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	if err := tel.shutdown(shutdownCtx); err != nil {
		log.Printf("otel shutdown: %v", err)
	}
	shutdownCancel()
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
		UpstreamName:  tidbHost,
		StateDir:      stateDir,
	}, nil
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func runForwarder(ts *tsnet.Server, listener net.Listener, target string, tel *telemetry) {
	for {
		conn, err := listener.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			log.Printf("forwarder accept: %v", err)
			return
		}
		go forwardConn(ts, conn, target, tel)
	}
}

func forwardConn(ts *tsnet.Server, src net.Conn, target string, tel *telemetry) {
	defer src.Close()

	connStart := time.Now()
	ctx := context.Background()
	upstreamAttr := attribute.String("proxy.upstream.name", tel.upstreamName)

	tel.acceptCount.Add(ctx, 1)
	tel.activeConns.Add(1)
	defer tel.activeConns.Add(-1)

	// proxy.forward span は proxy された TCP 接続 (= MySQL セッション) の一生。
	peerHost, peerPort := splitHostPort(src.RemoteAddr().String())
	forwardCtx, span := tel.tracer.Start(ctx, "proxy.forward",
		trace.WithSpanKind(trace.SpanKindServer),
		trace.WithAttributes(
			attribute.String("net.transport", "ip_tcp"),
			attribute.String("net.peer.ip", peerHost),
			attribute.Int("net.peer.port", peerPort),
			upstreamAttr,
		))
	defer span.End()

	// accept 〜 upstream dial 開始までのハンドオフを示すマーカー span。
	_, acceptSpan := tel.tracer.Start(forwardCtx, "proxy.accept")
	acceptSpan.End()

	dialStart := time.Now()
	dialCtx, cancel := context.WithTimeout(forwardCtx, 5*time.Second)
	connectCtx, connectSpan := tel.tracer.Start(dialCtx, "proxy.upstream.connect",
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(upstreamAttr))
	dst, err := ts.Dial(connectCtx, "tcp", target)
	cancel()
	tel.upstreamConnectDur.Record(ctx, durationMs(dialStart), metric.WithAttributes(upstreamAttr))
	if err != nil {
		errType := "connect_error"
		if errors.Is(err, context.DeadlineExceeded) {
			errType = "connect_timeout"
			tel.timeoutCount.Add(ctx, 1)
		}
		tel.errorCount.Add(ctx, 1,
			metric.WithAttributes(attribute.String("error.type", errType)))
		connectSpan.RecordError(err)
		connectSpan.SetStatus(codes.Error, errType)
		connectSpan.End()
		span.SetAttributes(
			attribute.String("proxy.close.reason", "error"),
			attribute.String("error.type", errType),
		)
		span.SetStatus(codes.Error, errType)
		log.Printf("forwarder dial %s: %v", target, err)
		return
	}
	connectSpan.End()
	defer dst.Close()

	var bytesIn, bytesOut int64
	var errIn, errOut error
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		bytesIn, errIn = io.Copy(dst, src)
		if c, ok := dst.(interface{ CloseWrite() error }); ok {
			_ = c.CloseWrite()
		}
	}()
	go func() {
		defer wg.Done()
		bytesOut, errOut = io.Copy(src, dst)
		if c, ok := src.(interface{ CloseWrite() error }); ok {
			_ = c.CloseWrite()
		}
	}()
	wg.Wait()

	reason := closeReason(errIn, errOut)
	reasonAttr := attribute.String("proxy.close.reason", reason)

	tel.bytesIn.Add(ctx, bytesIn, metric.WithAttributes(upstreamAttr))
	tel.bytesOut.Add(ctx, bytesOut, metric.WithAttributes(upstreamAttr))
	tel.connectionDur.Record(ctx, durationMs(connStart),
		metric.WithAttributes(upstreamAttr, reasonAttr))
	if reason == "error" {
		tel.errorCount.Add(ctx, 1,
			metric.WithAttributes(attribute.String("error.type", "forward_error")))
	}

	span.SetAttributes(
		attribute.Int64("proxy.bytes.in", bytesIn),
		attribute.Int64("proxy.bytes.out", bytesOut),
		reasonAttr,
	)
	span.AddEvent("proxy.close", trace.WithAttributes(reasonAttr))
	if reason == "error" {
		span.SetStatus(codes.Error, "forward_error")
	}
}

func durationMs(start time.Time) float64 {
	return float64(time.Since(start)) / float64(time.Millisecond)
}

func splitHostPort(addr string) (string, int) {
	host, portStr, err := net.SplitHostPort(addr)
	if err != nil {
		return addr, 0
	}
	port, _ := strconv.Atoi(portStr)
	return host, port
}

// closeReason は双方向 copy の結果から接続クローズ理由を正規化する。
// 優先度: reset > error > timeout > eof (異常度の高い方を採用する)。
func closeReason(errs ...error) string {
	rank := map[string]int{"eof": 0, "timeout": 1, "error": 2, "reset": 3}
	reason := "eof"
	for _, err := range errs {
		if err == nil {
			continue
		}
		r := "error"
		var netErr net.Error
		if errors.Is(err, syscall.ECONNRESET) {
			r = "reset"
		} else if errors.As(err, &netErr) && netErr.Timeout() {
			r = "timeout"
		}
		if rank[r] > rank[reason] {
			reason = r
		}
	}
	return reason
}
